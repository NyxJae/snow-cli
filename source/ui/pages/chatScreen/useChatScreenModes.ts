import {useEffect, useState} from 'react';
import {configEvents} from '../../../utils/config/configEvents.js';
import {getOpenAiConfig} from '../../../utils/config/apiConfig.js';
import {
	getToolSearchEnabled,
	setToolSearchEnabled as persistToolSearchEnabled,
} from '../../../utils/config/projectSettings.js';
import {getSimpleMode} from '../../../utils/config/themeConfig.js';

type Options = {
	enableYolo?: boolean;
};

function readStoredFlag(key: string) {
	try {
		return localStorage.getItem(key) === 'true';
	} catch {
		return false;
	}
}

export function useChatScreenModes({enableYolo}: Options) {
	const [yoloMode, setYoloMode] = useState(() => {
		if (enableYolo !== undefined) {
			return enableYolo;
		}

		return readStoredFlag('snow-yolo-mode');
	});
	const [toolSearchDisabled, setToolSearchDisabled] = useState(
		() => !getToolSearchEnabled(),
	);
	const [simpleMode, setSimpleMode] = useState(() => getSimpleMode());
	const [showThinking, setShowThinking] = useState(() => {
		const config = getOpenAiConfig();
		return config.showThinking !== false;
	});

	useEffect(() => {
		try {
			localStorage.setItem('snow-yolo-mode', String(yoloMode));
		} catch {
			// Ignore localStorage errors
		}
	}, [yoloMode]);

	useEffect(() => {
		persistToolSearchEnabled(!toolSearchDisabled);
	}, [toolSearchDisabled]);

	useEffect(() => {
		const interval = setInterval(() => {
			const currentSimpleMode = getSimpleMode();
			if (currentSimpleMode !== simpleMode) {
				setSimpleMode(currentSimpleMode);
			}
		}, 1000);

		return () => clearInterval(interval);
	}, [simpleMode]);

	useEffect(() => {
		const handleConfigChange = (event: {type: string; value: any}) => {
			if (event.type === 'showThinking') {
				setShowThinking(event.value);
			}
		};

		configEvents.onConfigChange(handleConfigChange);

		return () => {
			configEvents.removeConfigChangeListener(handleConfigChange);
		};
	}, []);

	return {
		yoloMode,
		setYoloMode,
		toolSearchDisabled,
		setToolSearchDisabled,
		simpleMode,
		showThinking,
	};
}
