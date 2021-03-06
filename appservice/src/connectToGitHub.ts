/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SiteSourceControl } from 'azure-arm-website/lib/models';
import { TokenCredentials, WebResource } from 'ms-rest';
import { Response } from 'request';
import * as request from 'request-promise';
import * as vscode from 'vscode';
import { appendExtensionUserAgent, AzureTreeItem, DialogResponses, IActionContext, IAzureQuickPickItem, IParsedError, parseError } from 'vscode-azureextensionui';
import { ext } from './extensionVariables';
import { localize } from './localize';
import { signRequest } from './signRequest';
import { SiteClient } from './SiteClient';
import { nonNullProp } from './utils/nonNull';
import { openUrl } from './utils/openUrl';
import { verifyNoRunFromPackageSetting } from './verifyNoRunFromPackageSetting';

type gitHubOrgData = { login: string, repos_url: string };
type gitHubReposData = { name: string, repos_url: string, url: string, html_url: string };
type gitHubBranchData = { name: string };
type gitHubLink = { prev?: string, next?: string, last?: string, first?: string };
// tslint:disable-next-line:no-reserved-keywords
type gitHubWebResource = WebResource & { resolveWithFullResponse?: boolean, nextLink?: string, type?: string };

export async function connectToGitHub(node: AzureTreeItem, client: SiteClient, context: IActionContext): Promise<void> {
    const requestOptions: gitHubWebResource = new WebResource();
    requestOptions.resolveWithFullResponse = true;
    requestOptions.headers = {
        ['User-Agent']: appendExtensionUserAgent()
    };
    const oAuth2Token: string | undefined = (await client.listSourceControls())[0].token;
    if (!oAuth2Token) {
        await showGitHubAuthPrompt(node, client, context);
        context.suppressErrorDisplay = true;
        const noToken: string = localize('noToken', 'No oAuth2 Token.');
        throw new Error(noToken);
    }

    await signRequest(requestOptions, new TokenCredentials(oAuth2Token));
    requestOptions.url = 'https://api.github.com/user';
    const gitHubUser: gitHubOrgData = await getJsonRequest<gitHubOrgData>(requestOptions, node, client, context);
    requestOptions.url = 'https://api.github.com/user/orgs';
    const gitHubOrgs: gitHubOrgData[] = await getJsonRequest<gitHubOrgData[]>(requestOptions, node, client, context);
    const orgQuickPicks: IAzureQuickPickItem<gitHubOrgData>[] = createQuickPickFromJsons([gitHubUser], 'login').concat(createQuickPickFromJsons(gitHubOrgs, 'login'));
    const orgQuickPick: gitHubOrgData = (await ext.ui.showQuickPick(orgQuickPicks, { placeHolder: 'Choose your organization.' })).data;
    requestOptions.url = nonNullProp(orgQuickPick, 'repos_url');

    const picksCache: ICachedQuickPicks<gitHubReposData> = { picks: [] };
    let repoQuickPick: gitHubReposData | undefined;
    do {
        repoQuickPick = (await ext.ui.showQuickPick(getGitHubReposQuickPicks(picksCache, requestOptions, node, client, context), { placeHolder: 'Choose repository.' })).data;
    } while (!repoQuickPick);

    requestOptions.url = `${repoQuickPick.url}/branches`;
    const gitHubBranches: gitHubBranchData[] = await getJsonRequest<gitHubBranchData[]>(requestOptions, node, client, context);
    const branchQuickPicks: IAzureQuickPickItem<gitHubBranchData>[] = createQuickPickFromJsons(gitHubBranches, 'name');
    const branchQuickPick: gitHubBranchData = (await ext.ui.showQuickPick(branchQuickPicks, { placeHolder: 'Choose branch.' })).data;

    const siteSourceControl: SiteSourceControl = {
        repoUrl: repoQuickPick.html_url,
        branch: branchQuickPick.name,
        isManualIntegration: false,
        deploymentRollbackEnabled: true,
        isMercurial: false
    };

    const repoName: string = `${orgQuickPick.login}/${repoQuickPick.name}`;

    try {
        const connectingToGithub: string = localize('ConnectingToGithub', '"{0}" is being connected to repo "{1}". This may take several minutes...', client.fullName, repoName);
        const connectedToGithub: string = localize('ConnectedToGithub', 'Repo "{0}" is connected and deployed to "{1}".', repoName, client.fullName);
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: connectingToGithub }, async (): Promise<void> => {
            ext.outputChannel.appendLine(connectingToGithub);
            await verifyNoRunFromPackageSetting(client);
            await client.updateSourceControl(siteSourceControl);
            vscode.window.showInformationMessage(connectedToGithub);
            ext.outputChannel.appendLine(connectedToGithub);
        });
    } catch (err) {
        try {
            // a resync will fix the first broken build
            // https://github.com/projectkudu/kudu/issues/2277
            await client.syncRepository();
        } catch (error) {
            const parsedError: IParsedError = parseError(error);
            // The portal returns 200, but is expecting a 204 which causes it to throw an error even after a successful sync
            if (parsedError.message.indexOf('"statusCode":200') === -1) {
                throw error;
            }
        }
    }
}

async function showGitHubAuthPrompt(node: AzureTreeItem, client: SiteClient, context: IActionContext): Promise<void> {
    const invalidToken: string = localize('tokenExpired', 'Azure\'s GitHub token is invalid.  Authorize in the "Deployment Center"');
    const goToPortal: vscode.MessageItem = { title: localize('goToPortal', 'Go to Portal') };
    let input: vscode.MessageItem | undefined = DialogResponses.learnMore;
    while (input === DialogResponses.learnMore) {
        input = await vscode.window.showErrorMessage(invalidToken, goToPortal, DialogResponses.learnMore);
        if (input === DialogResponses.learnMore) {

            context.properties.githubLearnMore = 'true';

            await openUrl('https://aka.ms/B7g6sw');
        }
    }

    if (input === goToPortal) {
        context.properties.githubGoToPortal = 'true';
        await node.openInPortal(`${client.id}/vstscd`);
    }
}

async function getJsonRequest<T>(requestOptions: gitHubWebResource, node: AzureTreeItem, client: SiteClient, context: IActionContext): Promise<T> {
    // Reference for GitHub REST routes
    // https://developer.github.com/v3/
    // Note: blank after user implies look up authorized user
    try {
        // tslint:disable-next-line:no-unsafe-any
        const gitHubResponse: Response = await request(requestOptions).promise();
        if (gitHubResponse.headers.link) {
            const headerLink: string = <string>gitHubResponse.headers.link;
            const linkObject: gitHubLink = parseLinkHeaderToGitHubLinkObject(headerLink);
            requestOptions.nextLink = linkObject.next;
        }
        // tslint:disable-next-line:no-unsafe-any
        return <T>JSON.parse(gitHubResponse.body);
    } catch (error) {
        const parsedError: IParsedError = parseError(error);
        if (parsedError.message.indexOf('Bad credentials') > -1) {
            // the default error is just "Bad credentials," which is an unhelpful error message
            await showGitHubAuthPrompt(node, client, context);
            context.suppressErrorDisplay = true;
        }
        throw error;
    }
}

/**
 * @param label Property of JSON that will be used as the QuickPicks label
 * @param description Optional property of JSON that will be used as QuickPicks description
 * @param data Optional property of JSON that will be used as QuickPicks data saved as a NameValue pair
 */
function createQuickPickFromJsons<T extends Object>(jsons: T[], label: string, description?: string): IAzureQuickPickItem<T>[] {
    const quickPicks: IAzureQuickPickItem<T>[] = [];
    for (const json of jsons) {
        if (!json[label]) {
            // skip this JSON if it doesn't have this label
            continue;
        }

        if (description && !json[description]) {
            // if the label exists, but the description does not, then description will just be left blank
            description = undefined;
        }

        quickPicks.push({
            label: <string>json[label],
            description: `${description ? json[description] : ''}`,
            data: json
        });
    }

    return quickPicks;
}

function parseLinkHeaderToGitHubLinkObject(linkHeader: string): gitHubLink {
    const linkUrls: string[] = linkHeader.split(', ');
    const linkMap: gitHubLink = {};

    // link header response is "<https://api.github.com/organizations/6154722/repos?page=2>; rel="prev", <https://api.github.com/organizations/6154722/repos?page=4>; rel="next""
    const relative: string = 'rel=';
    for (const url of linkUrls) {
        linkMap[url.substring(url.indexOf(relative) + relative.length + 1, url.length - 1)] = url.substring(url.indexOf('<') + 1, url.indexOf('>'));
    }
    return linkMap;
}

interface ICachedQuickPicks<T> {
    picks: IAzureQuickPickItem<T>[];
}

async function getGitHubReposQuickPicks(cache: ICachedQuickPicks<gitHubReposData>, requestOptions: gitHubWebResource, node: AzureTreeItem, client: SiteClient, context: IActionContext, timeoutSeconds: number = 10): Promise<IAzureQuickPickItem<gitHubReposData | undefined>[]> {
    const timeoutMs: number = timeoutSeconds * 1000;
    const startTime: number = Date.now();
    let gitHubRepos: gitHubReposData[] = [];
    do {
        gitHubRepos = gitHubRepos.concat(await getJsonRequest<gitHubReposData[]>(requestOptions, node, client, context));
        if (requestOptions.nextLink) {
            // if there is another link, set the next request url to point at that
            requestOptions.url = requestOptions.nextLink;
        }
    } while (requestOptions.nextLink && startTime + timeoutMs > Date.now());

    cache.picks = cache.picks.concat(createQuickPickFromJsons(gitHubRepos, 'name'));
    cache.picks.sort((a: vscode.QuickPickItem, b: vscode.QuickPickItem) => a.label.localeCompare(b.label));

    if (requestOptions.nextLink) {
        return (<IAzureQuickPickItem<gitHubReposData | undefined>[]>[{
            label: '$(sync) Load More',
            suppressPersistence: true,
            data: undefined
        }]).concat(cache.picks);
    } else {
        return cache.picks;
    }
}
