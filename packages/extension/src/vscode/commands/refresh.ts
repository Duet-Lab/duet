import * as vscode from 'vscode';
import { DuetApiClient, WorkspaceEntity } from '../../core/api-client';

/**
 * Trigger backend scan and load fresh workspaces.
 *
 * Flow: apiClient.scan() → apiClient.workspaces().
 * Returns fresh workspaces for updating providers.
 */
export async function refreshFromBackend(apiClient: DuetApiClient): Promise<WorkspaceEntity[]> {
    // 1. Trigger backend scan
    await apiClient.scan();

    // 2. Load fresh workspaces
    const { workspaces } = await apiClient.workspaces();

    return workspaces;
}

/**
 * Dump workspaces data to Output channel (debug command).
 */
export async function dumpIndex(apiClient: DuetApiClient): Promise<void> {
    try {
        const { workspaces } = await apiClient.workspaces();
        const output = vscode.window.createOutputChannel('Duet Index');
        output.appendLine(JSON.stringify(workspaces, null, 2));
        output.show();
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to dump index: ${error}`);
    }
}
