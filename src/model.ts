'use strict';

import * as nls from 'vscode-nls';
import { CommandServer, Status, HgError } from "./command_server";
import { commands, window, workspace, EventEmitter, Disposable, QuickDiffProvider, Uri, ProviderResult, scm, SourceControlResourceGroup, SourceControlResourceState, SourceControlResourceDecorations } from "vscode";
import { DisposableLike } from "./util";
import * as path from 'path';
import { DocumentProvider } from "./document_provider";

const localize = nls.loadMessageBundle();

export class Model implements DisposableLike, QuickDiffProvider { //TODO: can't open some files in unusual states (copied, renamed, untracked)
	private root: string;
	private readonly documentProvider: DocumentProvider = new DocumentProvider(this);

	private _repoState: RepoState = RepoState.NoRepo;
	private readonly repoStateChangeEmitter: EventEmitter<RepoState> = new EventEmitter();

	private changeWatcher: NodeJS.Timer | null;
	private lastRetrievedRevision: string;
	private _hasUntrackedFiles: boolean;
	private missingFiles: string[];

	private disposables: Disposable[] = [];

	private static readonly CHANGE_CHECK_INTERVAL = 1000 * 10;

	constructor(private commandServer: CommandServer, private changedFilesGroup: SourceControlResourceGroup,
		private resourceDecorationsProvider: (status: Status) => SourceControlResourceDecorations) {
		if (workspace.rootPath) {
			commandServer.directory = workspace.rootPath;
			setImmediate(this.updateRepoState.bind(this));
		}

		const providerDisposable = workspace.registerTextDocumentContentProvider(DocumentProvider.URI_SCHEME, this.documentProvider);
		const changeStateDisposable = this.repoStateChangeEmitter.event(() => {
			commands.executeCommand('setContext', 'hgState', REPO_STATE_IDS.get(this._repoState));
		});
		this.disposables.push(providerDisposable, changeStateDisposable);
	}

	async init(): Promise<void> {
		await this.commandServer.init();
		this.repoState = RepoState.Present;
	}

	async cat(fsPath: string): Promise<string> {
		if (!this.root) return "";

		const relativePath = path.relative(this.root, fsPath);
		return await this.commandServer.cat(fsPath);
	}

	async commit(message: string, addRemove: boolean): Promise<void> {
		await this.commandServer.commit(message, addRemove);
		this.checkStatusAndRevision();
	}

	async add(): Promise<void> {
		await this.commandServer.add();
		this.checkStatusAndRevision();
	}

	async forget(): Promise<void> {
		await this.commandServer.forget(...this.missingFiles);
		this.checkStatusAndRevision();
	}

	private async updateRepoState(): Promise<void> {
		try {
			await this.commandServer.status();
			this.root = await this.commandServer.root();
			this.repoState = RepoState.Present;
		} catch (err) {
			if (!(err instanceof HgError)) throw err;
			this.repoState = RepoState.NoRepo;
		}
	}

	private async checkRevision(): Promise<void> {
		try {
			const identifyResult = await this.commandServer.identify();
			const [revision] = identifyResult.split(" ", 2);
			if (this.lastRetrievedRevision != revision) {
				this.documentProvider.fireChangeEvents();
				this.lastRetrievedRevision = revision;
			}
		} catch (err) {
			if (!(err instanceof HgError)) throw err;
			this.updateRepoState();
		}
	}

	private async checkStatus(): Promise<void> {
		const statusMap = await this.commandServer.status();
		const trackedFiles: SourceControlResourceState[] = [];
		const untrackedFiles: SourceControlResourceState[] = [];

		for (const [filePath, { status, originalPath }] of statusMap) {
			const resourceUri = Uri.file(path.join(this.root, filePath));

			let command;
			switch (status) {
				case Status.Deleted:
				case Status.Missing:
					command = undefined;
					break;
				case Status.Added:
				case Status.Untracked:
					command = { title: localize("command.open", "Open"), command: "vscode.open", arguments: [resourceUri] };
					break;
				case Status.Copied:
				case Status.Renamed:
				case Status.Modified:
					const title = path.basename(resourceUri.fsPath);
					let originalResourceUri = DocumentProvider.toHgUri(originalPath ? Uri.file(path.join(this.root, originalPath)) : resourceUri);
					command = { title: localize("command.compare", "Compare"), command: 'vscode.diff', arguments: [originalResourceUri, resourceUri, title] };
					break;
				default:
					throw new Error(`Unknown status: ${status}`);
			}

			const state = { resourceUri, command, decorations: this.resourceDecorationsProvider(status) };
			(status == Status.Untracked ? untrackedFiles : trackedFiles).push(state);
		}

		const stateComparator = (a: SourceControlResourceState, b: SourceControlResourceState) => a.resourceUri.path.localeCompare(b.resourceUri.path);
		trackedFiles.sort(stateComparator);
		untrackedFiles.sort(stateComparator);

		this.changedFilesGroup.resourceStates = [...trackedFiles, ...untrackedFiles];

		this._hasUntrackedFiles = false;
		this.missingFiles = [];

		for (const [filePath, { status }] of statusMap) {
			switch (status) {
				case Status.Untracked:
					this._hasUntrackedFiles = true;
					break;
				case Status.Missing:
					this.missingFiles.push(filePath);
					break;
			}
		}
	}

	private async checkStatusAndRevision(): Promise<void> {
		await this.checkRevision();
		await this.checkStatus();
	}

	private set repoState(repoState: RepoState) {
		if (repoState == this._repoState) return;

		switch (repoState) {
			case RepoState.NoRepo:
				if (this.changeWatcher) {
					clearInterval(this.changeWatcher);
					this.changeWatcher = null;
				}
				break;
			case RepoState.Present:
				this.checkStatusAndRevision();
				if (!this.changeWatcher) this.changeWatcher = setInterval(this.checkStatusAndRevision.bind(this), Model.CHANGE_CHECK_INTERVAL);
				break;
		}

		this._repoState = repoState;
		this.repoStateChangeEmitter.fire(repoState);
	}

	get hasUntrackedFiles() {
		return this._hasUntrackedFiles;
	}

	get hasMissingFiles() {
		return this.missingFiles.length > 0;
	}

	provideOriginalResource(uri: Uri): ProviderResult<Uri> {
		return uri.scheme != 'file' ? undefined : DocumentProvider.toHgUri(uri);
	}

	dispose(): void {
		this.disposables.forEach((disposable) => disposable.dispose());
	}
}

enum RepoState {
	NoRepo = 0,
	Present = 1
}

const REPO_STATE_IDS: Map<RepoState, string> = new Map<RepoState, string>([
	[RepoState.NoRepo, "norepo"],
	[RepoState.Present, "present"]
]);