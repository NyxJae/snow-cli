import React from 'react';
import {Box, Text} from 'ink';
import {useTheme} from '../../contexts/ThemeContext.js';
import {useI18n} from '../../../i18n/index.js';

interface Props {
    question: string;
}

/**
 * 提问头部组件 - 静态显示问题标题和问题文本
 * 这个组件会被放入Static，不会重新渲染，避免屏闪
 */
export default function QuestionHeader({question}: Props) {
    const {theme} = useTheme();
    const {t} = useI18n();

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
                <Text dimColor> ({t.askUser.multiSelectHint || '可多选'})</Text>
            </Box>

            <Box>
                <Text>{question}</Text>
            </Box>
        </Box>
    );
}
