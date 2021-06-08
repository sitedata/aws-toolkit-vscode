/*!
 * Copyright 2018 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'

import { WizardControl } from '../wizards/wizard'
import { QuickInputButton } from './buttons'
import { Prompter, PrompterButtons } from './prompter'

export type QuickPickButton<T> = QuickInputButton<T | WizardControl>
type QuickPickButtons<T> = PrompterButtons<T>

/**
 * Options to configure the behavior of the quick pick UI.
 * Generally used to accommodate features not provided through vscode.QuickPickOptions
 */
export interface AdditionalQuickPickOptions<T=never> {
    title?: string
    value?: string
    step?: number
    placeholder?: string
    totalSteps?: number
    buttons?: QuickPickButtons<T>
}

export type ExtendedQuickPickOptions<T> = Omit<vscode.QuickPickOptions, 'buttons' | 'canPickMany'> & AdditionalQuickPickOptions<T>

export const DEFAULT_QUICKPICK_OPTIONS: vscode.QuickPickOptions = {
    ignoreFocusOut: true,
}

function applySettings<T1, T2 extends T1>(obj: T2, settings: T1): void {
    Object.assign(obj, settings)
}

export type QuickPickResult<T> = T | WizardControl | undefined

export type DataQuickPick<T> = Omit<vscode.QuickPick<DataQuickPickItem<T>>, 'buttons'> & { buttons: QuickPickButtons<T> }
export type DataQuickPickItem<T> = vscode.QuickPickItem & { data: QuickPickData<T> }
export type LabelQuickPickItem<T extends string> = vscode.QuickPickItem & { label: T, data?: QuickPickData<T> }


const CUSTOM_USER_INPUT = Symbol()
type QuickPickData<T> = QuickPickResult<T> | (() => Promise<QuickPickResult<T>>)

/**
 * Creates a QuickPick to let the user pick an item from a list
 * of items of type T.
 *
 * Used to wrap createQuickPick and accommodate
 * a common set of features for the Toolkit.
 *
 * Parameters:
 *  options - initial picker configuration
 *  items - set of selectable vscode.QuickPickItem based items to initialize the picker with
 *  buttons - set of buttons to initialize the picker with
 * @return A new QuickPick.
 */
export function createQuickPick<T>(
    items: DataQuickPickItem<T>[] | Promise<DataQuickPickItem<T>[] | undefined>,
    options?: ExtendedQuickPickOptions<T>
): QuickPickPrompter<T> {
    const picker = vscode.window.createQuickPick<DataQuickPickItem<T>>() as DataQuickPick<T>
    options = { ...DEFAULT_QUICKPICK_OPTIONS, ...options }
    applySettings(picker, { ...DEFAULT_QUICKPICK_OPTIONS, ...options })

    const prompter = new QuickPickPrompter<T>(picker)

    if (items instanceof Promise) { 
        makeQuickPickPrompterAsync(prompter, items)
    } else {
        picker.items = items
    }

    return prompter
}

/**
 * Creates QuickPick just to select from a label
 */
export function createLabelQuickPick<T extends string>(
    items: LabelQuickPickItem<T>[] | Promise<LabelQuickPickItem<T>[] | undefined>,
    options?: ExtendedQuickPickOptions<T>
): QuickPickPrompter<T> {
    if (items instanceof Promise) {
        return createQuickPick(items.then(items =>
            items !== undefined 
                ? items.map(item => ({ ...item, data: item.label }) as DataQuickPickItem<T>)
                : undefined
        ), options)
    }
    return createQuickPick(items.map(item => ({ ...item, data: item.label }) as DataQuickPickItem<T>), options)
}

/*
export function createMultiQuickPick<T>(
    items: DataQuickPickItem<T>[] | Promise<DataQuickPickItem<T>[] | undefined>, 
    options?: ExtendedQuickPickOptions<T>
): MultiQuickPickPrompter<T> {
    const picker = { ...vscode.window.createQuickPick<DataQuickPickItem<T>>(), buttons: [] }

    if (options) {
        applySettings(picker, options as vscode.QuickPickOptions)
    }

    const prompter = new MultiQuickPickPrompter<T>(picker)

    if (items instanceof Promise) { 
        makeQuickPickPrompterAsync(prompter, items)
    }

    return prompter
}
*/

/**
 * Quick helper function for asynchronous quick pick items
 */
function makeQuickPickPrompterAsync<T>(
    prompter: QuickPickPrompter<T>, // | MultiQuickPickPrompter<T>, 
    items: Promise<DataQuickPickItem<T>[] | undefined>
): void {
    const picker = prompter.quickInput as DataQuickPick<T>
    prompter.busy = true
    prompter.enabled = false

    items.then(items => {
        if (items === undefined) {
            picker.hide()
        } else {
            picker.items = items
            prompter.busy = false
            prompter.enabled = true
        }
    }).catch(err => {
        // TODO: this is an unhandled exception so we should log it appropriately
        picker.hide()
    })
}

export class QuickPickPrompter<T> extends Prompter<T, QuickPickResult<T>> {
    private lastPicked?: DataQuickPickItem<T>

    constructor(public readonly quickPick: DataQuickPick<T>) {
        super(quickPick)
    }
    
    private isUserInput(picked: any): picked is DataQuickPickItem<symbol> {
        return picked !== undefined && picked.data === CUSTOM_USER_INPUT
    }

    public async prompt(): Promise<QuickPickResult<T>> {
        const promptPromise = promptUser({
            picker: this.quickPick,
            onDidTriggerButton: (button, resolve, reject) => {
                button.onClick(arg => resolve([{ label: '', data: arg }]), reject)
            },
            prompter: this,
        })
        this.show()
        const choices = await promptPromise

        if (choices === undefined) {
            return choices
        }
        
        this.lastPicked = choices[0]
        const result = choices[0].data

        return super.applyAfterCallbacks(((result instanceof Function) ? await result() : result) )
    }

    public setLastResponse(picked: DataQuickPickItem<T> | undefined = this.lastPicked): void {
        if (picked === undefined) {
            return
        }

        this.quickPick.value = (this.isUserInput(picked) ? picked.description : undefined) ?? ''

        if (!this.isUserInput(picked)) {
            this.quickPick.activeItems = this.quickPick.items.filter(item => item.label === picked.label)
        }

        if (this.quickPick.activeItems.length === 0) {
            this.quickPick.activeItems = [this.quickPick.items[0]]
        }
    }

    public setCustomInput(transform: (v?: string) => T | WizardControl, label: string = ''): QuickPickPrompter<T> {
        const picker = this.quickInput as DataQuickPick<T | symbol>
        const items = picker.items 
        let lastUserInput: string | undefined

        function update(value?: string) {
            lastUserInput = value
            if (value !== undefined) {
                const customUserInputItem = {
                    label,
                    description: value,
                    alwaysShow: true,
                    data: CUSTOM_USER_INPUT,
                } as DataQuickPickItem<T | symbol>
    
                picker.items = [customUserInputItem, ...(items ?? [])]
            } else {
                picker.items = items ?? []
            }
        }

        picker.onDidChangeValue(update)

        return this.after(async selection => {
            if ((selection as (T | typeof CUSTOM_USER_INPUT)) === CUSTOM_USER_INPUT) {
                return transform(lastUserInput)
            } 
            return selection
        }) as QuickPickPrompter<T>
    }

    public getLastResponse(): T | DataQuickPickItem<T> | DataQuickPickItem<T>[] | undefined {
        return this.lastPicked
    }
}

/*
export class MultiQuickPickPrompter<T, U extends Array<T> = Array<T>> extends Prompter<U> {
    private lastPicked?: DataQuickPickItem<T>[]

    constructor(private readonly quickPick: DataQuickPick<T>) {
        super(quickPick)
    }

    public setLastResponse(picked: DataQuickPickItem<T>[] | undefined = this.lastPicked): void {
        if (picked === undefined) {
            return
        }

        this.quickPick.activeItems = this.quickPick.items.filter(item => picked.map(it => it.label).includes(item.label))

        if (this.quickPick.activeItems.length === 0) {
            this.quickPick.activeItems = []
        }
    }

    public async prompt(): Promise<PromptResult<U>> {
        const choices = await promptUser({
            picker: this.quickPick,
            onDidTriggerButton: (button, resolve, reject) => {
                button.onClick(arg => resolve([{ label: '', data: arg }]), reject)
            },
        })

        if (choices === undefined) {
            return choices
        }

        this.lastPicked = choices

        const result = choices.map(choices => choices.data)

        // Any control signal in the choices will be collapsed down into a single return value
        result.forEach(element => {
            if (isWizardControl(element)) {
                return element
            }
        })

        return await Promise.all(result.map(async f => f instanceof Function ? await f() : f)) as U
    }

    public getLastResponse(): DataQuickPickItem<T>[] | undefined {
        return this.lastPicked
    }
}
*/

/**
 * Convenience method to allow the QuickPick to be treated more like a dialog.
 *
 * This method shows the picker, and returns after the picker is either accepted or cancelled.
 * (Accepted = the user accepted selected values, Cancelled = hide() is called or Esc is pressed)
 *
 * @param picker The picker to prompt the user with
 * @param onDidTriggerButton Optional event to trigger when the picker encounters a "Button Pressed" event.
 *  Buttons do not automatically cancel/accept the picker, caller must explicitly do this if intended.
 *
 * @returns If the picker was cancelled, undefined is returned. Otherwise, an array of the selected items is returned.
 */
export async function promptUser<T>({
    picker,
    onDidTriggerButton,
    prompter
}: {
    picker: DataQuickPick<T>
    onDidTriggerButton?(
        button: QuickPickButton<T>,
        resolve: (value: DataQuickPickItem<T>[]) => void,
        reject: (reason?: any) => void
    ): void,
    prompter?: Prompter<T>
}): Promise<DataQuickPickItem<T>[] | undefined> {
    const disposables: vscode.Disposable[] = []

    try {
        const response = await new Promise<DataQuickPickItem<T>[] | undefined>((resolve, reject) => {
            picker.onDidAccept(
                () => {
                    resolve(Array.from(picker.selectedItems))
                },
                picker,
                disposables
            )

            picker.onDidHide(
                () => {
                    resolve(undefined) // change to WIZARD_EXIT
                },
                picker,
                disposables
            )

            if (onDidTriggerButton) {
                picker.onDidTriggerButton(
                    //(btn: vscode.QuickInputButton) => onDidTriggerButton(btn as QuickPickButton<T>, resolve, reject),
                    (btn: vscode.QuickInputButton) => prompter!.activateButton(btn),
                    picker,
                    disposables
                )
            }
        })

        return response
    } finally {
        disposables.forEach(d => d.dispose() as void)
        picker.hide()
    }
}
