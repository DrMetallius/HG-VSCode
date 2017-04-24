'use strict';

import * as nls from 'vscode-nls';
import * as os from 'os';
import * as path from 'path';
import * as cp from 'child_process';
import { window, Uri, commands, Disposable, OutputChannel, scm, workspace } from "vscode";
import { HgError, CommandServer } from "./command_server";
import { mkdirs, DisposableLike } from "./util";
import { Model } from "./model";

const localize = nls.loadMessageBundle();

export class CommandCenter implements DisposableLike {
	private disposables: Disposable[] = [];
	private commandIdMap: Map<(...args: any[]) => Promise<any>, string> = new Map([
		[this.clone, "hg.clone"],
		[this.init, "hg.init"],
		[this.commit, "hg.commit"]
	]);
	
	constructor(private commandServer: CommandServer, private model: Model, private outputChannel: OutputChannel) {
		for (let [commandFunction, cmdId] of this.commandIdMap) {
			const wrappedCommand = async (...args) => {
				try {
					return await commandFunction.call(this, ...args);
				} catch (err) {
					console.error(`${cmdId}: ${err.stack || err.message || err}`);

					const openOutputChannelChoice = localize('msg.commandErrorChoiceOpenLog', "Open Mercurial Log");
					const choice = await window.showErrorMessage(err.message || localize('msg.commandError', `Error when calling {0}`, cmdId), openOutputChannelChoice);

					if (choice === openOutputChannelChoice) outputChannel.show();
				}
			};
			this.disposables.push(commands.registerCommand(cmdId, wrappedCommand));
		}
	}

	private async clone(): Promise<void> {
		const url = await window.showInputBox({
			prompt: localize('prompt.repositoryUrl', "Repository URL"),
			ignoreFocusOut: true
		});

		if (!url) throw new Error(localize("err.noRepoUrl", 'Repository URL not specified'));

		const repoNameMatch = /\/([^\/]*$)/.exec(url);
		const folderName = repoNameMatch && repoNameMatch[1] ? repoNameMatch[1] : 'repository';
		const destPathSuggestion = path.join(os.homedir(), folderName);

		const destPath = await window.showInputBox({
			prompt: localize('prompt.targetDirectory', "Target Directory"),
			value: destPathSuggestion,
			ignoreFocusOut: true
		});

		if (!destPath) throw new Error(localize('err.noTargetDirectory', 'Target folder not specified'));

		const clonePromise = this.commandServer.clone(url, destPath);
		window.setStatusBarMessage(localize('status.cloning', "Cloning Mercurial repository..."), clonePromise);

		await clonePromise;

		const open = localize('msg.openClonedChoiceOpen', "Open Repository");
		const result = await window.showInformationMessage(localize('msg.openCloned', "Would you like to open the cloned repository?"), open);
		if (result === open) commands.executeCommand('vscode.openFolder', Uri.file(destPath));
	}

	private async init(): Promise<void> {
		await this.model.init();
	}

	private async commit(): Promise<void> {
		let message = scm.inputBox.value;
		if (!message) {
			const input = await window.showInputBox({
				prompt: localize("prompt.commitMessage", "Commit Message"),
				ignoreFocusOut: true
			});
			if (!input) throw new Error(localize("err.noCommitMessage", "Please enter a commit message"));

			message = input;
		}

		await workspace.saveAll();
		await this.model.commit(message);
		scm.inputBox.value = "";
	}

	dispose(): void {
		this.disposables.forEach((disposable) => disposable.dispose());
	}
}
