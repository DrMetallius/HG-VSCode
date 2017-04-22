'use strict';

import * as path from 'path';
import * as cp from 'child_process';
import { EventEmitter, InputBoxOptions, window } from "vscode";
import { dirname } from "path";
import * as fs from 'fs';
import { DisposableLike, mkdirs, trimTrailingNewLine } from "./util";
import { ChildProcess } from "child_process";

export class HgProperties {
	path: string;
	version: string;
}

export function findHgWin32(): Promise<HgProperties | null> { //TODO: add other ways to search for it
	return new Promise<HgProperties>((resolve, reject) => {
		const buffers: Buffer[] = [];
		const child = cp.spawn("hg", ['version', '-T', 'json']);
		child.stdout.on('data', (b: Buffer) => buffers.push(b));
		child.on('error', reject);
		child.on('exit', code => {
			if (code) reject(new Error(`Mercurial executable not found, code ${code}`));

			const properties = parseVersion(Buffer.concat(buffers).toString('utf8').trim());
			if (properties) {
				resolve(properties);
			} else {
				reject(new Error("Couldn't parse the hg version output"));
			}
		});
	});
}

function parseVersion(raw: string): HgProperties | null {
	let output: any;
	try {
		output = JSON.parse(raw);
	} catch (err) {
		return null;
	}

	if (!output[0] || !output[0].ver) return null;
	return { path: "hg", version: output[0].ver };
}

export class CommandServer implements DisposableLike {
	private readonly hg: ChildProcess;
	private started: boolean;

	private commandExecutionInProgress: boolean;
	private commandQueue = new Array<ScheduledCommand>();

	directory: string;

	private static readonly ENCODING = "UTF-8";
	private static readonly SERVER_COMMAND_RUN = "runcommand";

	private static readOutput(dataBuf: Buffer): Message[] {
		const messages: Message[] = [];

		let bufferPos = 0;
		while (bufferPos < dataBuf.length) {
			const channelTypeChar: string = dataBuf.toString(CommandServer.ENCODING, bufferPos, bufferPos + 1);
			const dataLength = dataBuf.readUInt32BE(bufferPos + 1);
			bufferPos += 5;

			const channelType = CHANNEL_TYPE_IDS.get(channelTypeChar);
			if (channelType == undefined) {
				throw new Error(`Unknown channel type: ${channelTypeChar}`);
			}

			switch (channelType) {
				case ChannelType.Output:
				case ChannelType.Error:
				case ChannelType.Debug: {
					const data = dataBuf.toString(CommandServer.ENCODING, bufferPos, bufferPos + dataLength);
					messages.push(new OutputMessage(channelType, data));
					break;
				}
				case ChannelType.Result: {
					if (dataLength != 4) throw new Error(`Expected data length 4 for a result message, but was ${dataLength}`);

					const returnCode = dataBuf.readUInt32BE(bufferPos);
					messages.push(new ResultMessage(returnCode));
					break;
				}
				case ChannelType.Input:
				case ChannelType.Line:
					messages.push(new InputRequestMessage(dataLength));
					break;
			}

			bufferPos += dataLength;
		}

		return messages;
	}

	constructor(private hgPath: string, private version: string, private outputReceiver: (channelType: ChannelType | null, data: string) => void,
		private promptHandler: (prompt: string, password: boolean) => Promise<string>) {
		const options = {
			env: {
				HGENCODING: CommandServer.ENCODING,
				LANGUAGE: "en_US." + CommandServer.ENCODING // We need this at least to determine that the input is a password until we use extensions which tell us that
			}
		};
		this.hg = cp.spawn(hgPath, ["--config", "ui.interactive=yes", "serve", "--cmdserver", "pipe"], options); //TODO: handle non-launching or premature exit
	}

	async start(): Promise<void> {
		return new Promise<Message[]>((resolve, reject) => {
			const dataListener = (data) => {
				this.hg.stdout.removeListener('data', dataListener);
				resolve(CommandServer.readOutput(<Buffer>data))
			};
			this.hg.stdout.on('data', dataListener);
		}).then((message) => {
			const params = (<OutputMessage>message[0]).data
				.split("\n")
				.map((line) => line.split(": "))
				.reduce((existingValue, currentValue, currentIndex, array) => {
					const [key, value] = currentValue;
					existingValue[key] = value;
					return existingValue;
				}, new Map<string, string>());


			if (params["encoding"] != CommandServer.ENCODING) {
				throw new Error(`Expected encoding ${CommandServer.ENCODING}, but found ${params["encoding"]}`);
			}

			if (!params["capabilities"].split(" ").includes(CommandServer.SERVER_COMMAND_RUN)) {
				throw new Error(`${CommandServer.SERVER_COMMAND_RUN} capability not supported`);
			}
		});
	}

	private scheduleCommand(command: string, ...args: string[]): Promise<string> {
		return new Promise((resolve, reject) => {
			this.commandQueue.push({resolve, reject, command, args});
			if (!this.commandExecutionInProgress) this.executeNextCommand();
		});
	}

	private async executeNextCommand(): Promise<void> {
		if (this.commandExecutionInProgress) throw new Error("Another command is already executing");

		let scheduledCommand = this.commandQueue.shift();
		if (!scheduledCommand) throw new Error("No scheduled commands");

		this.commandExecutionInProgress = true;

		if (!this.started) {
			await this.start();
			this.started = true;
		}

		let {resolve: resolveCommand, reject: rejectCommand, command, args} = scheduledCommand;

		const extendedArgs = args;
		if (this.directory) extendedArgs.unshift("--cwd", this.directory);

		const commandAndArgs = [command, ...extendedArgs];
		this.outputReceiver(null, `\nhg ${commandAndArgs.join(" ")}\n`);

		const serverCommand: string = `${CommandServer.SERVER_COMMAND_RUN}\n`;
		const packedServerCommandArgs: string = commandAndArgs.join("\0");

		const serverCommandLength = Buffer.byteLength(serverCommand);
		const packedArgsLength = Buffer.byteLength(packedServerCommandArgs);

		const buf: Buffer = Buffer.allocUnsafe(serverCommandLength + 4 + packedArgsLength);
		buf.write(serverCommand, 0, serverCommandLength);
		buf.writeUInt32BE(packedArgsLength, serverCommandLength);
		buf.write(packedServerCommandArgs, serverCommandLength + 4);

		this.hg.stdin.write(buf);

		let finishAndScheduleNext = () => {
			this.commandExecutionInProgress = false;
			if (this.commandQueue.length > 0) this.executeNextCommand();
		};

		let stdout = "";
		let output = "";
		return new Promise<number>((resolve, reject) => {
			const dataListener = async (data) => {
				const messageBatch: Message[] = CommandServer.readOutput(<Buffer>data);
				for (var message of messageBatch) {
					if (message instanceof OutputMessage) {
						this.outputReceiver(message.channelType, message.data);

						if (message.channelType == ChannelType.Output) stdout += message.data;
						if (message.channelType != ChannelType.Debug) output += message.data;
					} else if (message instanceof ResultMessage) {
						this.hg.stdout.removeListener('data', dataListener);
						resolve(message.returnCode);
						return;
					} else if (message instanceof InputRequestMessage) {
						const prompt = this.getPromptFromOutput(output);

						const password = prompt == "password";
						let userResponse = await this.promptHandler(prompt, password);
						userResponse = userResponse.replace("\n", "") + "\n";
						this.writeInput(userResponse);

						this.outputReceiver(null, password ? "\n" : userResponse);
						output += "\n";
					} else {
						throw new Error(`Message is of unknown type ${typeof message}`);
					}
				}
			};
			this.hg.stdout.on('data', dataListener);
		}).then((returnCode) => {
			setImmediate(finishAndScheduleNext);

			if (returnCode != 0) {
				const message = this.getLastLineFromOutput(output);
				rejectCommand(new HgError({ returnCode, command, message }));
			} else {
				resolveCommand(stdout);
			}
		}, (error) => {
			setImmediate(finishAndScheduleNext);
			rejectCommand(new HgError({ error, command }));
		});
	}

	private getLastLineFromOutput(output: string): string {
		let lastLine: string;
		let lastLineBreak = output.lastIndexOf("\n");
		if (lastLineBreak < 0) {
			lastLine = output;
		} else if (lastLineBreak == output.length - 1) {
			lastLineBreak = output.lastIndexOf("\n", lastLineBreak - 1);
			lastLine = lastLineBreak < 0 ? output.substring(0, output.length - 1) : lastLine = output.substring(lastLineBreak + 1, output.length - 1);
		} else {
			lastLine = output.substring(lastLineBreak + 1);
		}
		return lastLine;
	}

	private getPromptFromOutput(output: string): string {
		let prompt = this.getLastLineFromOutput(output).trim();
		if (prompt.endsWith(":")) prompt = prompt.substring(0, prompt.length - 1);
		return prompt;
	}

	private writeInput(input: string) {
		const dataLength = Buffer.byteLength(input, CommandServer.ENCODING);
		const buffer: Buffer = Buffer.alloc(4 + dataLength);
		buffer.writeUInt32BE(dataLength, 0);
		buffer.write(input, 4, dataLength, CommandServer.ENCODING);

		this.hg.stdin.write(buffer);
	}

	async clone(url: string, destPath?: string): Promise<void> {
		if (destPath) {
			await mkdirs(destPath);
			await this.scheduleCommand('clone', url, destPath);
		} else {
			await this.scheduleCommand('clone', url);
		}
	}

	async init(): Promise<void> {
		await this.scheduleCommand('init');
	}

	async status(): Promise<void> {
		await this.scheduleCommand('status');
	}

	async root(): Promise<string> {
		return trimTrailingNewLine(await this.scheduleCommand('root'));
	}

	async cat(file: string): Promise<string> {
		return await this.scheduleCommand('cat', file);
	}

	async identify(): Promise<string> {
		return trimTrailingNewLine(await this.scheduleCommand('identify'));
	}

	async commit(message: string): Promise<void> {
		await this.scheduleCommand('commit', '-m', message);
	}

	dispose(): void {
		this.hg.stdin.end();
	}
}

enum ChannelType {
	Output,
	Error,
	Result,
	Debug,
	Input,
	Line
}

const CHANNEL_TYPE_IDS: Map<string, ChannelType> = new Map<string, ChannelType>([
	["o", ChannelType.Output],
	["e", ChannelType.Error],
	["r", ChannelType.Result],
	["d", ChannelType.Debug],
	["I", ChannelType.Input],
	["L", ChannelType.Line]
]);

type Message = OutputMessage | ResultMessage | InputRequestMessage;

class OutputMessage {
	constructor(readonly channelType: ChannelType, readonly data: string) { }
}

class ResultMessage {
	constructor(readonly returnCode: number) { }
}

class InputRequestMessage {
	constructor(readonly dataLength: number) { }
}

class ScheduledCommand {
	resolve: Function;
	reject: Function;
	command: string;
	args: string[];
}

interface HgErrorData {
	error?: Error;
	message?: string;
	returnCode?: number;
	command: string;
}

export class HgError {
	error?: Error;
	message: string;
	returnCode?: number;
	command: string;

	constructor(data: HgErrorData) {
		if (data.error) {
			this.error = data.error;
			this.message = data.error.message;
		} else {
			this.error = void 0;
		}

		this.message = this.message || data.message || `hg ${this.command} error`;
		this.returnCode = data.returnCode;
		this.command = data.command;
	}
}
