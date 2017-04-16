'use strict';

import { workspace, Uri, Disposable, Event, EventEmitter, window, TextDocumentContentProvider } from 'vscode';
import { Model } from './model';
import { DisposableLike } from "./util";

interface CacheRow {
	uri: Uri;
	lastAccessed: number;
}

export class DocumentProvider implements TextDocumentContentProvider {
	private cache: Map<string, CacheRow> = new Map();
	private onDidChangeEmitter = new EventEmitter<Uri>();

    private static readonly LAST_ACCESS_TIMEOUT = 1000 * 60 * 3;
    private static readonly CLEANUP_INTERVAL = 1000 * 60 * 5;

	static readonly URI_SCHEME = "hg";
	static readonly URI_FILE_EXT = ".hg";

    static toHgUri(uri: Uri): Uri {
        return new Uri().with({
            scheme: DocumentProvider.URI_SCHEME,
            path: uri.path + DocumentProvider.URI_FILE_EXT
        });
    }

    static getPathFromHgUri(uri: Uri): string {
        return uri.fsPath.substring(0, uri.fsPath.length - DocumentProvider.URI_FILE_EXT.length);
    }

	constructor(private model: Model) {
		setInterval(() => this.cleanup(), DocumentProvider.CLEANUP_INTERVAL);
	}

	fireChangeEvents(): void {
		Object.keys(this.cache).forEach(key => this.onDidChangeEmitter.fire(this.cache[key].uri));
	}

	async provideTextDocumentContent(uri: Uri): Promise<string> {
		const cacheKey = uri.toString();
		const lastAccessed = new Date().getTime();
		const cacheValue = {
            uri,
            lastAccessed
        };

		this.cache.set(cacheKey, cacheValue);

		try {
			return await this.model.cat(DocumentProvider.getPathFromHgUri(uri));
		} catch (err) {
			return '';
		}
	}

	private cleanup(): void {
		const now = new Date().getTime();
		const cache = new Map();

        for (let [key, row] of this.cache) {
            const fsPath = DocumentProvider.getPathFromHgUri(row.uri);
			const isOpen = window.visibleTextEditors.some(editor => editor.document.uri.fsPath === fsPath);
			if (isOpen || now - row.lastAccessed < DocumentProvider.LAST_ACCESS_TIMEOUT) cache.set(row.uri.toString(), row);
		};

		this.cache = cache;
	}

	get onDidChange(): Event<Uri> {
        return this.onDidChangeEmitter.event;
    }
}