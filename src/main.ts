'use strict';

import * as nls from 'vscode-nls';
import { ExtensionContext, Disposable, window, workspace, scm, commands, Uri, InputBoxOptions } from "vscode";
import { findHgWin32, CommandServer } from "./command_server";
import { CommandCenter } from "./commands";
import { Model } from "./model";

const localize = nls.config()();

export function activate(context: ExtensionContext): any { //TODO: update line endings and whitespace
	const disposables: Disposable[] = [];
	context.subscriptions.push(new Disposable(() => Disposable.from(...disposables).dispose()));

	init(context, disposables)
		.catch(err => console.error(err));
}

async function init(context: ExtensionContext, disposables: Disposable[]): Promise<void> {
	const config = workspace.getConfiguration('hg');
	const enabled = config.get<boolean>('enabled') === true;
	if (!enabled) return;

	const outputChannel = window.createOutputChannel('Mercurial');
	disposables.push(outputChannel);

	const info = await findHgWin32();
	if (!info) return;

	outputChannel.appendLine(localize('out.mercurialVer', "Using Mercurial {0} from {1}", info.version, info.path));

	const commandServer = new CommandServer(info.path, info.version, (channelType, data) => {
		outputChannel.append(data);
	}, async (prompt: string, password: boolean) => {
		const localizedPrompt = localize("hgprompt." + prompt, prompt);
		const options: InputBoxOptions = {
			password,
			prompt: localizedPrompt,
			ignoreFocusOut: true
		};

		const result = await window.showInputBox(options);
		return result || '';
	});
	const model = new Model(commandServer);
	const commandCenter = new CommandCenter(commandServer, model, outputChannel);
	const sourceControl = scm.createSourceControl('hg', 'Mercurial');
	disposables.push(commandServer, commandCenter, model, sourceControl);

	const result = /^(\d)\./.exec(info.version);
	if (!result || parseInt(result[1]) < 4) {
		const update = localize('msg.recommendedVersionChoiceUpdate', "Update Mercurial");
		const choice = await window.showWarningMessage(localize('msg.recommendedVersion', "You seem to have Mercurial {0} installed. " +
				"The plugin works best with Mercurial >= 4.0.0", info.version), update);

		if (choice === update) commands.executeCommand('vscode.open', Uri.parse('https://www.mercurial-scm.org/'));
	}
}