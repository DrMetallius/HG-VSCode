'use strict';

import * as nls from 'vscode-nls';
import { CommandServer } from "./command_server";
import { commands, window, workspace, EventEmitter, Disposable, QuickDiffProvider, Uri, ProviderResult, scm } from "vscode";
import { DisposableLike } from "./util";
import * as path from 'path';
import { DocumentProvider } from "./document_provider";

const localize = nls.loadMessageBundle();

export class Model implements DisposableLike, QuickDiffProvider {
	private root: string;
	private readonly documentProvider: DocumentProvider = new DocumentProvider(this);

	private _repoState: RepoState = RepoState.NoRepo;
	private readonly repoStateChangeEmitter: EventEmitter<RepoState> = new EventEmitter();

	private changeWatcher: NodeJS.Timer | null;
	private lastRetrievedRevision: string;

	private disposables: Disposable[] = [];

	private static readonly EXTERNAL_CHANGE_CHECK_INTERVAL = 1000 * 10;

	constructor(private commandServer: CommandServer) {
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

	async commit(message: string): Promise<void> {
		await this.commandServer.commit(message);
		this.checkRevision();
	}

	private async updateRepoState(): Promise<void> {
		try {
			await this.commandServer.status();
			this.root = await this.commandServer.root();
			this.repoState = RepoState.Present;
		} catch (err) {
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
			this.updateRepoState();
		}
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
				if (!this.changeWatcher) this.changeWatcher = setInterval(this.checkRevision.bind(this), Model.EXTERNAL_CHANGE_CHECK_INTERVAL);
				break;
		}

		this._repoState = repoState;
		this.repoStateChangeEmitter.fire(repoState);
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