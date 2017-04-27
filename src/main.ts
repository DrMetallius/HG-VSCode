'use strict';

import * as nls from 'vscode-nls';
import { ExtensionContext, Disposable, window, workspace, scm, commands, Uri, InputBoxOptions, SourceControlResourceThemableDecorations, SourceControlResourceDecorations } from "vscode";
import { findHgWin32, CommandServer, Status } from "./command_server";
import { CommandCenter } from "./commands";
import { Model } from "./model";
import { assertNonEmptyResult } from "./util";
import * as path from 'path';

const localize = nls.config()();

export function activate(context: ExtensionContext): any { //TODO: update line endings and whitespace
	const disposables: Disposable[] = [];
	context.subscriptions.push(new Disposable(() => Disposable.from(...disposables).dispose()));

	init(context, disposables)
		.catch(err => console.error(err));
}

async function init(context: ExtensionContext, disposables: Disposable[]): Promise<void> { //TODO: add a status for missing files, asking about untracked on commit, partial commit, status bar, pull, push, revert, branch switching, try in a subfolder of root
	const config = workspace.getConfiguration('hg');
	const enabled = config.get<boolean>('enabled') === true;
	if (!enabled) return;

	const outputChannel = window.createOutputChannel('Mercurial');
	disposables.push(outputChannel);

	const info = await findHgWin32();
	if (!info) return;

	outputChannel.appendLine(localize('out.mercurialVer', "Using Mercurial {0} from {1}", info.version, info.path));

	const sourceControl = scm.createSourceControl('hg', 'Mercurial');
	sourceControl.acceptInputCommand = { title: localize("command.commit", "Commit Changes"), command: "hg.commit" };
	const changedFilesGroup = sourceControl.createResourceGroup("changes", localize("resourceGroup.changes", "Changes"));

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

	const model = new Model(commandServer, changedFilesGroup, assertNonEmptyResult(STATUS_ICONS.get.bind(STATUS_ICONS)));
	sourceControl.quickDiffProvider = model;

	const commandCenter = new CommandCenter(commandServer, model, outputChannel);

	disposables.push(commandServer, commandCenter, model, sourceControl);

	const result = /^(\d)\./.exec(info.version);
	if (!result || parseInt(result[1]) < 4) {
		const update = localize('msg.recommendedVersionChoiceUpdate', "Update Mercurial");
		const choice = await window.showWarningMessage(localize('msg.recommendedVersion', "You seem to have Mercurial {0} installed. " +
			"The plugin works best with Mercurial >= 4.0.0", info.version), update);

		if (choice === update) commands.executeCommand('vscode.open', Uri.parse('https://www.mercurial-scm.org/'));
	}
}

const STATUS_ICONS = new Map<Status, SourceControlResourceDecorations>();

{
	const iconPathRoot = path.join(path.dirname(__dirname), '..', 'resources', 'icons');

	const iconNames = new Map<Status, string>([
		[Status.Added, "status-added.svg"],
		[Status.Copied, "status-copied.svg"],
		[Status.Deleted, "status-deleted.svg"],
		[Status.Missing, "status-missing.svg"],
		[Status.Modified, "status-modified.svg"],
		[Status.Renamed, "status-renamed.svg"],
		[Status.Untracked, "status-untracked.svg"]
		]);

	for (const [status, name] of iconNames) {
		const light: SourceControlResourceThemableDecorations = {iconPath: Uri.file(path.join(iconPathRoot, "light", name))};
		const dark: SourceControlResourceThemableDecorations = {iconPath: Uri.file(path.join(iconPathRoot, "dark", name))};
		STATUS_ICONS.set(status, {dark, light, strikeThrough: status == Status.Deleted || status == Status.Missing});
	};
}