import React from 'react';
import {Box, Text} from 'ink';
import {useTheme} from '../../contexts/ThemeContext.js';

interface PendingMessage {
	text: string;
	images?: Array<{data: string; mimeType: string}>;
}

interface Props {
	pendingMessages: PendingMessage[];
	expectedTarget?: 'main' | 'subagent';
	expectedTargetName?: string;
}

export default function PendingMessages({
	pendingMessages,
	expectedTarget = 'main',
	expectedTargetName,
}: Props) {
	const {theme} = useTheme();
	const targetLabel =
		expectedTarget === 'subagent'
			? `子代理${expectedTargetName ? ` (${expectedTargetName})` : ''}`
			: '主代理';

	if (pendingMessages.length === 0) {
		return null;
	}

	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor={theme.colors.warning}
			paddingX={1}
		>
			<Text color={theme.colors.warning} bold>
				⬑ 待发送消息 ({pendingMessages.length})
			</Text>
			<Text color={theme.colors.warning} dimColor>
				预计目标: {targetLabel}
			</Text>
			{pendingMessages.map((message, index) => (
				<Box key={index} marginLeft={1} marginY={0} flexDirection="column">
					<Box>
						<Text color="blue" bold>
							{index + 1}.
						</Text>
						<Box marginLeft={1}>
							<Text color={theme.colors.menuSecondary}>
								{message.text.length > 60
									? `${message.text.substring(0, 60)}...`
									: message.text}
							</Text>
						</Box>
					</Box>
					{message.images && message.images.length > 0 && (
						<Box marginLeft={3}>
							<Text color={theme.colors.menuSecondary} dimColor>
								└─ 已附加 {message.images.length} 张图片
							</Text>
						</Box>
					)}
				</Box>
			))}

			<Text color={theme.colors.warning} dimColor>
				按 ESC 可撤回到输入框,不会打断当前流程
			</Text>
		</Box>
	);
}
