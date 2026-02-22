import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG_DIR = path.join(os.homedir(), '.snow');
const PROFILES_DIR = path.join(CONFIG_DIR, 'profiles');
const ACTIVE_PROFILE_FILE = path.join(CONFIG_DIR, 'active-profile.json');

/**
 * 渠道配置选项服务.
 * 读取 ~/.snow/profiles 下的配置名,用于前端渠道下拉展示.
 */
export class ProfileOptionsService {
	/**
	 * 获取可用渠道名与当前激活渠道.
	 */
	public list(): {profiles: string[]; activeProfile: string} {
		const profiles = this.readProfiles();
		const activeProfile = this.readActiveProfile(profiles);
		return {
			profiles,
			activeProfile,
		};
	}

	/**
	 * 读取全部配置文件名.
	 */
	private readProfiles(): string[] {
		if (!fs.existsSync(PROFILES_DIR)) {
			return ['default'];
		}
		try {
			const result = fs
				.readdirSync(PROFILES_DIR)
				.filter(fileName => fileName.endsWith('.json'))
				.map(fileName => fileName.replace(/\.json$/i, ''))
				.filter(Boolean)
				.sort((left, right) => left.localeCompare(right));
			return result.length > 0 ? result : ['default'];
		} catch {
			return ['default'];
		}
	}

	/**
	 * 读取当前激活配置.
	 */
	private readActiveProfile(profiles: string[]): string {
		if (!fs.existsSync(ACTIVE_PROFILE_FILE)) {
			return profiles[0] ?? 'default';
		}
		try {
			const raw = fs.readFileSync(ACTIVE_PROFILE_FILE, 'utf8');
			const parsed = JSON.parse(raw) as {activeProfile?: string};
			const activeProfile = String(parsed?.activeProfile ?? '').trim();
			if (activeProfile && profiles.includes(activeProfile)) {
				return activeProfile;
			}
		} catch {
			// ignore
		}
		return profiles[0] ?? 'default';
	}
}

export const profileOptionsService = new ProfileOptionsService();
