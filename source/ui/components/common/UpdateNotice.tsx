import React from 'react';
import {Box, Text} from 'ink';
import {useI18n} from '../../../i18n/index.js';

type UpdateNoticeProps = {
	currentVersion: string;
	latestVersion: string;
	terminalWidth: number;
};

export default function UpdateNotice({
	currentVersion,
	latestVersion,
	terminalWidth,
}: UpdateNoticeProps) {
	const {t} = useI18n();

	return (
		<Box paddingX={1} marginBottom={1}>
			<Box
				borderStyle="double"
				borderColor="#FFD700"
				paddingX={2}
				paddingY={1}
				width={terminalWidth - 2}
			>
				<Box flexDirection="column">
					<Text bold color="#FFD700">
						{t.welcome.updateNoticeTitle}
					</Text>
					<Text color="gray" dimColor>
						{t.welcome.updateNoticeCurrent}:{' '}
						<Text color="gray">{currentVersion}</Text>
					</Text>
					<Text color="gray" dimColor>
						{t.welcome.updateNoticeLatest}:{' '}
						<Text color="#FFD700" bold>
							{latestVersion}
						</Text>
					</Text>
					<Text color="gray" dimColor>
						{t.welcome.updateNoticeRun}:{' '}
						<Text color="#FFD700" bold>
							snow --update
						</Text>
					</Text>
					<Text color="gray" dimColor>
						{t.welcome.updateNoticeGithub}:{' '}
						https://github.com/MayDay-wpf/snow-cli
					</Text>
				</Box>
			</Box>
		</Box>
	);
}
