import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type {UsefulInfoList} from '../../mcp/types/usefulInfo.types.js';

/**
 * File checkpoint data structure
 */
export interface FileCheckpoint {
	path: string; // File absolute path
	content: string; // Original file content
	timestamp: number; // Checkpoint creation time
	exists: boolean; // Whether file existed before operation
}

/**
 * Useful information snapshot for checkpoint
 */
export interface UsefulInfoSnapshot {
	items: Array<{
		id: string;
		filePath: string;
		startLine: number;
		endLine: number;
		description?: string;
		createdAt: string;
		updatedAt: string;
	}>;
	timestamp: number;
}

/**
 * Conversation checkpoint data structure
 */
export interface ConversationCheckpoint {
	sessionId: string; // Session ID
	messageCount: number; // Number of messages before AI response
	fileSnapshots: FileCheckpoint[]; // File snapshots list
	usefulInfoSnapshot?: UsefulInfoSnapshot; // Useful information snapshot
	timestamp: number; // Checkpoint creation time
}

/**
 * Checkpoint Manager
 * Manages file snapshots for rollback on ESC interrupt
 */
class CheckpointManager {
	private readonly checkpointsDir: string;
	private activeCheckpoint: ConversationCheckpoint | null = null;
	private getUsefulInfoService: () => any; // Lazy injection to avoid circular dependency

	constructor(getUsefulInfoService?: () => any) {
		this.checkpointsDir = path.join(os.homedir(), '.snow', 'checkpoints');
		this.getUsefulInfoService = getUsefulInfoService || (() => null);
	}

	/**
	 * Ensure checkpoints directory exists
	 */
	private async ensureCheckpointsDir(): Promise<void> {
		try {
			await fs.mkdir(this.checkpointsDir, {recursive: true});
		} catch (error) {
			// Directory already exists or other error
		}
	}

	/**
	 * Get checkpoint file path for a session
	 */
	private getCheckpointPath(sessionId: string): string {
		return path.join(this.checkpointsDir, `${sessionId}.json`);
	}

	/**
	 * Create a new checkpoint before AI response
	 * @param sessionId - Current session ID
	 * @param messageCount - Number of messages before AI response
	 */
	async createCheckpoint(
		sessionId: string,
		messageCount: number,
	): Promise<void> {
		await this.ensureCheckpointsDir();

		// Capture useful information snapshot
		let usefulInfoSnapshot: UsefulInfoSnapshot | undefined;
		try {
			const usefulInfoService = this.getUsefulInfoService();
			if (usefulInfoService) {
				const usefulInfoList: UsefulInfoList | null =
					await usefulInfoService.getUsefulInfoList(sessionId);
				if (usefulInfoList && usefulInfoList.items.length > 0) {
					usefulInfoSnapshot = {
						items: usefulInfoList.items,
						timestamp: Date.now(),
					};
				}
			}
		} catch (error) {
			console.warn('Failed to capture useful information snapshot:', error);
			// Continue without useful info snapshot
		}

		this.activeCheckpoint = {
			sessionId,
			messageCount,
			fileSnapshots: [],
			usefulInfoSnapshot,
			timestamp: Date.now(),
		};

		// Save checkpoint immediately (will be updated as files are modified)
		await this.saveCheckpoint();
	}

	/**
	 * Record a file snapshot before modification
	 * @param filePath - Absolute path to the file
	 */
	async recordFileSnapshot(filePath: string): Promise<void> {
		if (!this.activeCheckpoint) {
			return; // No active checkpoint, skip
		}

		// Check if this file already has a snapshot
		const existingSnapshot = this.activeCheckpoint.fileSnapshots.find(
			snapshot => snapshot.path === filePath,
		);

		if (existingSnapshot) {
			return; // Already recorded, skip
		}

		try {
			// Try to read existing file content
			const content = await fs.readFile(filePath, 'utf-8');
			this.activeCheckpoint.fileSnapshots.push({
				path: filePath,
				content,
				timestamp: Date.now(),
				exists: true,
			});
		} catch (error) {
			// File doesn't exist, record as non-existent
			this.activeCheckpoint.fileSnapshots.push({
				path: filePath,
				content: '',
				timestamp: Date.now(),
				exists: false,
			});
		}

		// Update checkpoint file
		await this.saveCheckpoint();
	}

	/**
	 * Save current checkpoint to disk
	 */
	private async saveCheckpoint(): Promise<void> {
		if (!this.activeCheckpoint) {
			return;
		}

		await this.ensureCheckpointsDir();
		const checkpointPath = this.getCheckpointPath(
			this.activeCheckpoint.sessionId,
		);
		await fs.writeFile(
			checkpointPath,
			JSON.stringify(this.activeCheckpoint, null, 2),
		);
	}

	/**
	 * Load checkpoint from disk
	 */
	async loadCheckpoint(
		sessionId: string,
	): Promise<ConversationCheckpoint | null> {
		try {
			const checkpointPath = this.getCheckpointPath(sessionId);
			const data = await fs.readFile(checkpointPath, 'utf-8');
			return JSON.parse(data);
		} catch (error) {
			return null;
		}
	}

	/**
	 * Rollback files to checkpoint state
	 * @param sessionId - Session ID to rollback
	 * @returns Number of messages to rollback to, or null if no checkpoint
	 */
	async rollback(sessionId: string): Promise<number | null> {
		const checkpoint = await this.loadCheckpoint(sessionId);
		if (!checkpoint) {
			return null;
		}

		// Rollback all file snapshots
		for (const snapshot of checkpoint.fileSnapshots) {
			try {
				if (snapshot.exists) {
					// Restore original file content
					await fs.writeFile(snapshot.path, snapshot.content, 'utf-8');
				} else {
					// Delete file that was created
					try {
						await fs.unlink(snapshot.path);
					} catch (error) {
						// File may already be deleted, ignore
					}
				}
			} catch (error) {
				console.error(`Failed to rollback file ${snapshot.path}:`, error);
			}
		}

		// Restore useful information snapshot
		try {
			if (checkpoint.usefulInfoSnapshot) {
				const usefulInfoService = this.getUsefulInfoService();
				if (usefulInfoService) {
					// Clear current useful info
					await usefulInfoService.deleteUsefulInfoList(sessionId);

					// Restore snapshot
					if (checkpoint.usefulInfoSnapshot.items.length > 0) {
						const restoreRequests = checkpoint.usefulInfoSnapshot.items.map(
							item => ({
								filePath: item.filePath,
								startLine: item.startLine,
								endLine: item.endLine,
								description: item.description,
							}),
						);

						await usefulInfoService.addUsefulInfo(sessionId, restoreRequests);
						console.log(
							`Restored ${checkpoint.usefulInfoSnapshot.items.length} useful information items`,
						);
					}
				}
			}
		} catch (error) {
			console.warn('Failed to restore useful information snapshot:', error);
			// Continue with file rollback even if useful info restoration fails
		}

		// Clear checkpoint after rollback
		await this.clearCheckpoint(sessionId);

		return checkpoint.messageCount;
	}

	/**
	 * Clear checkpoint for a session
	 */
	async clearCheckpoint(sessionId: string): Promise<void> {
		try {
			const checkpointPath = this.getCheckpointPath(sessionId);
			await fs.unlink(checkpointPath);
		} catch (error) {
			// Checkpoint may not exist, ignore
		}

		if (this.activeCheckpoint?.sessionId === sessionId) {
			this.activeCheckpoint = null;
		}
	}

	/**
	 * Get active checkpoint
	 */
	getActiveCheckpoint(): ConversationCheckpoint | null {
		return this.activeCheckpoint;
	}

	/**
	 * Clear active checkpoint (used when conversation completes successfully)
	 */
	async commitCheckpoint(): Promise<void> {
		if (this.activeCheckpoint) {
			await this.clearCheckpoint(this.activeCheckpoint.sessionId);
		}
	}
}

export const checkpointManager = new CheckpointManager(() => {
	try {
		// Use dynamic import for ES modules to avoid circular dependency
		const {getUsefulInfoService} = require('../execution/mcpToolsManager.js');
		return getUsefulInfoService();
	} catch (error) {
		console.warn(
			'Failed to get useful info service for checkpoint manager:',
			error,
		);
		return null;
	}
});
