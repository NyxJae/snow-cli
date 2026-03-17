import React, {useMemo} from 'react';
import {Box, Text} from 'ink';
import {useTheme} from '../../contexts/ThemeContext.js';
import {useI18n} from '../../../i18n/index.js';

interface Props {
	question: string;
	options: string[];
	multiSelect?: boolean;
}

/**
 * 提问头部组件 - 静态显示问题标题和问题文本.
 *
 * 这个组件会被放入 Static,不会重新渲染,避免屏闪.
 * 同时在静态区显示选项列表,避免用户误按 ESC 导致交互区消失后,只能看到问题但看不到选项.
 */
export default function QuestionHeader({
	question,
	options,
	multiSelect,
}: Props) {
	const {theme} = useTheme();
	const {t} = useI18n();

	const safeOptions = useMemo(
		() => (Array.isArray(options) ? options : []),
		[options],
	);

	return (
		<Box
			flexDirection="column"
			marginX={1}
			marginY={1}
			borderStyle={'round'}
			borderColor={theme.colors.menuInfo}
			paddingX={1}
		>
			<Box marginBottom={1}>
				<Text bold color={theme.colors.menuInfo}>
					{t.askUser.header}
				</Text>
				{multiSelect !== false && (
					<Text dimColor> ({t.askUser.multiSelectHint || '可多选'})</Text>
				)}
			</Box>

			<Box flexDirection="column">
				<Text>{question}</Text>

				{safeOptions.length > 0 && (
					<Box flexDirection="column" marginTop={1}>
						<Text dimColor>{t.askUser.selectPrompt}</Text>
						{safeOptions.map((opt, idx) => (
							<Text key={`opt-${idx}`} dimColor>
								{idx + 1}. {opt}
							</Text>
						))}
					</Box>
				)}
			</Box>
		</Box>
	);
}
