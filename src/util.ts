/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { Event } from 'vscode';
import { dirname } from 'path';
import * as fs from 'fs';

export interface DisposableLike {
	dispose(): void;
}

function fsFunToPromise<R>(fsFun: Function, ...args): Promise<R> {
	return new Promise((resolve, reject) => fsFun(...args, (err, result) => err ? reject(err) : resolve(result)));
}

async function mkdir(path: string, mode?: number) {
	try {
		await fsFunToPromise(fs.mkdir, path, mode);
	} catch (err) {
		if (err.code === 'EEXIST') {
			const stat = await fsFunToPromise<fs.Stats>(fs.stat, path);
			if (stat.isDirectory) return;

			throw new Error(`'${path}' already exists and it isn't a directory`);
		}

		throw err;
	}
}

export async function mkdirs(path: string, mode?: number): Promise<void> {
	if (path === dirname(path)) return;

	try {
		await mkdir(path, mode);
	} catch (err) {
		if (err.code !== 'ENOENT') throw err;

		await mkdirs(dirname(path), mode);
		await mkdir(path, mode);
	}
}

export function trimTrailingNewLine(str: string) {
	return !str.endsWith("\n") ? str : str.substring(0, str.length - 1);
}