/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { localize } from '../localize';
import { AzExtParentTreeItem } from './AzExtParentTreeItem';
import { AzExtTreeItem } from './AzExtTreeItem';

class InvalidTreeItem<TRoot> extends AzExtParentTreeItem<TRoot> {
    public readonly contextValue: string;
    public readonly label: string;
    public readonly description: string;

    // tslint:disable-next-line:no-any
    private _error: any;

    // tslint:disable-next-line:no-any
    constructor(parent: AzExtParentTreeItem<TRoot>, label: string, error: any, contextValue: string, description: string = localize('invalid', 'Invalid')) {
        super(parent);
        this.label = label;
        this._error = error;
        this.contextValue = contextValue;
        this.description = description;
    }

    public get iconPath(): string {
        return path.join(__filename, '..', '..', '..', '..', 'resources', 'warning.svg');
    }

    public async loadMoreChildrenImpl(): Promise<AzExtTreeItem<TRoot>[]> {
        throw this._error;
    }

    public hasMoreChildrenImpl(): boolean {
        return false;
    }

    public isAncestorOfImpl(): boolean {
        // never display invalid items in tree picker
        return false;
    }
}

export async function createTreeItemsWithErrorHandling<TSource, TTreeItem>(
    treeItem: AzExtParentTreeItem<TTreeItem>,
    sourceArray: TSource[],
    invalidContextValue: string,
    createTreeItem: (source: TSource) => AzExtTreeItem<TTreeItem> | undefined | Promise<AzExtTreeItem<TTreeItem> | undefined>,
    getLabelOnError: (source: TSource) => string | undefined | Promise<string | undefined>): Promise<AzExtTreeItem<TTreeItem>[]> {

    const treeItems: AzExtTreeItem<TTreeItem>[] = [];
    // tslint:disable-next-line:no-any
    let unknownError: any;
    await Promise.all(sourceArray.map(async (source: TSource) => {
        try {
            const item: AzExtTreeItem<TTreeItem> | undefined = await createTreeItem(source);
            if (item) {
                treeItems.push(item);
            }
        } catch (error) {
            let name: string | undefined;
            try {
                name = await getLabelOnError(source);
            } catch {
                // ignore
            }

            if (name) {
                treeItems.push(new InvalidTreeItem<TTreeItem>(treeItem, name, error, invalidContextValue));
            } else if (error && !unknownError) {
                unknownError = error;
            }
        }
    }));

    if (unknownError) {
        // Display a generic error if there are any unknown items. Only the first error will be displayed
        const message: string = localize('cantShowItems', 'Some items could not be displayed');
        treeItems.push(new InvalidTreeItem<TTreeItem>(treeItem, message, unknownError, invalidContextValue, ''));
    }

    return treeItems;
}
