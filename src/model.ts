'use strict';

import * as nls from 'vscode-nls';
import { CommandServer } from "./command_server";
import { commands, window, workspace, EventEmitter, Disposable } from "vscode";
import { DisposableLike } from "./util";

const localize = nls.loadMessageBundle();

export class Model implements DisposableLike {
	private _repoState: RepoState = RepoState.NoRepo;
	private readonly repoStateChangeEmitter: EventEmitter<RepoState> = new EventEmitter();

	private disposables: Disposable[] = [];

	constructor(private commandServer: CommandServer) {
		if (workspace.rootPath) {
			commandServer.directory = workspace.rootPath;
			process.nextTick(async () => {
				try {
					await commandServer.status();
					this.repoState = RepoState.Present;
				} catch (err) {
					this.repoState = RepoState.NoRepo;
				}
			});
		}

		this.repoStateChangeEmitter.event(() => {
			commands.executeCommand('setContext', 'hgState', REPO_STATE_IDS.get(this._repoState));
		});
	}

	async init() {
		await this.commandServer.init();
		this.repoState = RepoState.Present;
	}

	private set repoState(repoState: RepoState) {
		this._repoState = repoState;
		this.repoStateChangeEmitter.fire(repoState);
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