/*!
 * Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'path'
import * as vscode from 'vscode'
import * as mime from 'mime-types'
import * as telemetry from '../shared/telemetry/telemetry'
import * as S3 from '../shared/clients/s3Client'
import { getLogger } from '../shared/logger'
import { showConfirmationMessage } from '../shared/utilities/messages'
import { localize } from '../shared/utilities/vsCodeUtils'
import { parse } from '@aws-sdk/util-arn-parser'
import { TimeoutError } from '../shared/utilities/timeoutUtils'
import { downloadFile } from './commands/downloadFileAs'
import { DefaultSettingsConfiguration } from '../shared/settingsConfiguration'
import { s3FileViewerHelpUrl } from '../shared/constants'
import { FileProvider, MemoryFileSystem } from '../shared/memoryFilesystem'
import { S3Client } from '../shared/clients/s3Client'

export const S3_EDIT_SCHEME = 's3'
export const S3_READ_SCHEME = 's3-readonly'
const SIZE_LIMIT = 4 * Math.pow(10, 6) // 4 MB
const PROMPT_ON_EDIT_KEY = 'fileViewerEdit'

export enum TabMode {
    Read = 'read',
    Edit = 'edit',
}

export interface S3Tab {
    dispose(): Promise<void> | void
    readonly mode: TabMode
    readonly file: S3File
    readonly editor: vscode.TextEditor | undefined
}

// Essentially combines the File and Bucket interface as they mostly belong together
export interface S3File extends S3.File {
    readonly bucket: S3.Bucket
}

export class S3FileProvider implements FileProvider {
    private readonly _onDidChange = new vscode.EventEmitter<void>()
    private readonly _file: { -readonly [P in keyof S3File]: S3File[P] }
    public readonly onDidChange = this._onDidChange.event

    public constructor(private readonly client: S3Client, file: S3File) {
        this._file = { ...file }
    }

    public async refresh(): Promise<void> {
        const { bucket, key } = this._file
        const stats = await this.client.headObject({ bucketName: bucket.name, key })

        this._file.eTag = stats.ETag
        this._file.sizeBytes = stats.ContentLength
        this._file.lastModified = stats.LastModified
    }

    public async read(): Promise<Uint8Array> {
        const result = downloadFile(this._file, {
            client: this.client,
            progressLocation:
                (this._file.sizeBytes ?? 0) < SIZE_LIMIT
                    ? vscode.ProgressLocation.Window
                    : vscode.ProgressLocation.Notification,
        })

        result.then(() => {
            telemetry.recordS3DownloadObject({ result: 'Succeeded', component: 'viewer' })
        })
        // TODO: add way to record component on failure/cancel

        return result
    }

    public async stat(): Promise<{ ctime: number; mtime: number; size: number }> {
        await this.refresh()

        return {
            ctime: 0,
            size: this._file.sizeBytes ?? 0,
            mtime: this._file.lastModified?.getTime() ?? 0,
        }
    }

    public async write(content: Uint8Array): Promise<void> {
        const result = await this.client
            .uploadFile({
                content,
                bucketName: this._file.bucket.name,
                key: this._file.key,
            })
            .then(u => u.promise())

        this._file.eTag = result.ETag
        this._file.lastModified = new Date()
        this._file.sizeBytes = content.byteLength
        //await vscode.commands.executeCommand('aws.refreshAwsExplorer', true)
    }
}

type S3ClientFactory = (region: string) => S3Client

export class S3FileViewerManager {
    private readonly activeTabs: { [uri: string]: S3Tab | undefined } = {}
    private readonly providers: { [uri: string]: vscode.Disposable | undefined } = {}
    private readonly disposables: vscode.Disposable[] = []

    public constructor(private readonly clientFactory: S3ClientFactory, private readonly fs: MemoryFileSystem) {
        this.disposables.push(this.registerTabCleanup())
    }

    /**
     * Removes all active editors as well as any underlying files
     */
    public async dispose(): Promise<void> {
        await Promise.all([
            ...Object.values(this.activeTabs).map(v => v?.dispose()),
            ...Object.values(this.providers).map(v => v?.dispose()),
        ])
        vscode.Disposable.from(...this.disposables).dispose()
    }

    private registerTabCleanup(): vscode.Disposable {
        return vscode.workspace.onDidCloseTextDocument(async doc => {
            const key = this.fs.uriToKey(doc.uri)
            await this.activeTabs[key]?.dispose()
        })
    }

    /**
     * Opens a new editor, closing the previous one if it exists
     */
    private async openEditor(
        fileUri: vscode.Uri,
        options?: vscode.TextDocumentShowOptions
    ): Promise<vscode.TextEditor | undefined> {
        const fsPath = fileUri.fsPath

        await this.activeTabs[this.fs.uriToKey(fileUri)]?.dispose()

        // Defer to `vscode.open` for non-text files
        const contentType = mime.contentType(path.extname(fsPath))
        if (contentType && mime.charset(contentType) != 'UTF-8') {
            await vscode.commands.executeCommand('vscode.open', fileUri)
            return vscode.window.visibleTextEditors.find(
                e => this.fs.uriToKey(e.document.uri) === this.fs.uriToKey(fileUri)
            )
        }

        const document = await vscode.workspace.openTextDocument(fileUri)
        return await vscode.window.showTextDocument(document, options)
    }

    private async closeEditor(editor: vscode.TextEditor | undefined): Promise<void> {
        if (editor && !editor.document.isClosed) {
            await vscode.window.showTextDocument(editor.document, { preserveFocus: false })
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
        }
    }

    private async tryFocusTab(uri: vscode.Uri): Promise<S3Tab | undefined> {
        const activeTab = this.activeTabs[this.fs.uriToKey(uri)]

        if (activeTab) {
            if (activeTab.editor) {
                getLogger().verbose(`S3FileViewer: Editor already opened, refocusing`)
                await vscode.window.showTextDocument(activeTab.editor.document)
            } else {
                getLogger().verbose(`S3FileViewer: Reopening non-text document`)
                await vscode.commands.executeCommand('vscode.open', uri)
            }
        }

        return activeTab
    }

    /**
     * Given an S3FileNode, this function:
     * Checks and creates a cache to store downloads
     * Retrieves previously cached files on cache and
     * Downloads file from S3 ands stores in cache
     * Opens the tab on read-only with the use of an S3Tab, or shifts focus to an edit tab if any.
     *
     * @param fileNode
     */
    public async openInReadMode(file: S3File): Promise<void> {
        const contentType = mime.contentType(path.extname(file.name))
        const isTextDocument = contentType && mime.charset(contentType) == 'UTF-8'

        if (!isTextDocument) {
            return this.openInEditMode(file)
        }

        const uri = this.fileToUri(file, TabMode.Read)
        if ((await this.tryFocusTab(uri)) || (await this.tryFocusTab(uri.with({ scheme: S3_EDIT_SCHEME })))) {
            return
        }

        await this.createTab(file, TabMode.Read)
    }

    private async showEditNotification(): Promise<void> {
        const settings = new DefaultSettingsConfiguration()

        if (!(await settings.isPromptEnabled(PROMPT_ON_EDIT_KEY))) {
            return
        }

        const message = localize(
            'AWS.s3.fileViewer.warning.editStateWarning',
            'You are now editing an S3 file. Saved changes will be uploaded to your S3 bucket.'
        )

        const dontShow = localize('AWS.s3.fileViewer.button.dismiss', "Don't show this again")
        const help = localize('AWS.generic.message.learnMore', 'Learn more')

        await vscode.window.showWarningMessage(message, dontShow, help).then<unknown>(selection => {
            if (selection === dontShow) {
                return settings.disablePrompt(PROMPT_ON_EDIT_KEY)
            }

            if (selection === help) {
                return vscode.env.openExternal(vscode.Uri.parse(s3FileViewerHelpUrl, true))
            }
        })
    }

    /**
     * Given an S3FileNode or an URI, this function:
     * Checks and creates a cache to store downloads
     * Retrieves previously cached files on cache and
     * Downloads file from S3 ands stores in cache
     * Opens the tab on read-only with the use of an S3Tab, or shifts focus to an edit tab if any.
     *
     * @param uriOrFile to be opened
     */
    public async openInEditMode(uriOrFile: vscode.Uri | S3File): Promise<void> {
        const uri = uriOrFile instanceof vscode.Uri ? uriOrFile : this.fileToUri(uriOrFile, TabMode.Edit)
        const activeTab = await this.tryFocusTab(uri)
        const file = activeTab?.file ?? uriOrFile

        if (activeTab?.mode === 'edit') {
            return
        }

        if (file instanceof vscode.Uri) {
            throw new Error('Cannot open from URI without an active tab')
        }

        await activeTab?.dispose()
        this.showEditNotification()

        await this.createTab(file, TabMode.Edit)
    }

    private registerProvider(file: S3File, uri: vscode.Uri): vscode.Disposable {
        const provider = new S3FileProvider(this.clientFactory(file.bucket.region), file)
        return this.fs.registerProvider(uri, provider)
    }

    /**
     * Creates a new tab based on the mode
     */
    private async createTab(file: S3File, mode: S3Tab['mode']): Promise<void> {
        if (!(await this.canContinueDownload(file))) {
            throw new TimeoutError('cancelled')
        }

        const uri = this.fileToUri(file, mode)
        const key = this.fs.uriToKey(uri)
        const provider = (this.providers[key] ??= this.registerProvider(file, uri))
        const editor = await this.openEditor(uri, { preview: mode === TabMode.Read })

        this.activeTabs[this.fs.uriToKey(uri)] = {
            file,
            mode,
            editor,
            dispose: async () => {
                await this.closeEditor(editor)
                delete this.activeTabs[key]
                // Note that providers without an editor will persist for the lifetime of the extension
                // since we have no way of detecting when a webview-type editor closes
                if (editor) {
                    provider.dispose()
                    delete this.providers[key]
                }
            },
        }
    }

    private async canContinueDownload(file: S3File): Promise<boolean> {
        const fileSize = file.sizeBytes
        const warningMessage = (function () {
            if (fileSize === undefined) {
                getLogger().debug(`FileViewer: File size couldn't be determined, prompting user file: ${file.name}`)

                return localize(
                    'AWS.s3.fileViewer.warning.noSize',
                    "File size couldn't be determined. Continue with download?"
                )
            } else if (fileSize > SIZE_LIMIT) {
                getLogger().debug(`FileViewer: File size ${fileSize} is >4MB, prompting user`)

                return localize('AWS.s3.fileViewer.warning.4mb', 'File size is more than 4MB. Continue with download?')
            }
        })()

        if (warningMessage && !(await this.showDownloadConfirmation(warningMessage))) {
            return false
        }

        return true
    }

    private async showDownloadConfirmation(warningMessage: string): Promise<boolean> {
        const args = {
            prompt: warningMessage,
            confirm: localize('AWS.generic.continueDownload', 'Continue with download'),
            cancel: localize('AWS.generic.cancel', 'Cancel'),
        }

        if (!(await showConfirmationMessage(args))) {
            getLogger().debug(`FileViewer: User cancelled download`)
            return false
        }

        return true
    }

    private fileToUri(file: S3File, mode: S3Tab['mode']): vscode.Uri {
        const parts = parse(file.arn)
        const fileName = path.basename(parts.resource)
        const fsPath = path.join(file.bucket.region, path.dirname(parts.resource), `[S3] ${fileName}`)

        return vscode.Uri.parse(fsPath).with({
            scheme: mode === TabMode.Read ? S3_READ_SCHEME : S3_EDIT_SCHEME,
        })
    }
}
