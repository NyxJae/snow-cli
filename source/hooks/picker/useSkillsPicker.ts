import {useCallback, useEffect, useMemo, useState} from 'react';
import {TextBuffer} from '../../utils/ui/textBuffer.js';
import type {Skill} from '../../mcp/skills.js';

export type SkillsPickerFocus = 'search' | 'append';

// 构建注入的skill文本，包含skill-info信息块
async function buildInjectedSkillText(
	skill: Skill,
	appendText: string,
): Promise<string> {
	const append = appendText.trim();
	const skillBody = skill.content.trim();

	// 如果skill markdown提供了$ARGUMENTS占位符，填充它
	// 否则保持遗留行为（追加单独的[User Append]块）
	if (skillBody.includes('$ARGUMENTS')) {
		const replaced = skillBody.split('$ARGUMENTS').join(append);
		// 导入并使用共享的generateSkillInfoBlock函数
		const {generateSkillInfoBlock} = await import('../../mcp/skills.js');
		const skillInfo = await generateSkillInfoBlock(skill);
		return `# Skill: ${skill.id}\n\n${replaced}${skillInfo}`.trim();
	}

	const appendBlock = append ? `\n\n[User Append]\n${append}\n` : '';
	// 导入并使用共享的generateSkillInfoBlock函数
	const {generateSkillInfoBlock} = await import('../../mcp/skills.js');
	const skillInfo = await generateSkillInfoBlock(skill);

	// 保持纯文本格式；实际的skill prompt是markdown
	return `# Skill: ${skill.id}\n\n${skillBody}${appendBlock}${skillInfo}`.trim();
}

export function useSkillsPicker(buffer: TextBuffer, triggerUpdate: () => void) {
	const [showSkillsPicker, setShowSkillsPicker] = useState(false);
	const [skillsSelectedIndex, setSkillsSelectedIndex] = useState(0);
	const [allSkills, setAllSkills] = useState<Skill[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [searchQuery, setSearchQuery] = useState('');
	const [appendText, setAppendText] = useState('');
	const [focus, setFocus] = useState<SkillsPickerFocus>('search');
	const [originalTextBeforeOpen, setOriginalTextBeforeOpen] = useState('');

	const filteredSkills = useMemo(() => {
		const q = searchQuery.trim().toLowerCase();
		if (!q) return allSkills;
		return allSkills.filter(skill => {
			return (
				skill.id.toLowerCase().includes(q) ||
				skill.name.toLowerCase().includes(q) ||
				skill.description.toLowerCase().includes(q)
			);
		});
	}, [allSkills, searchQuery]);

	// Load skills when picker is shown.
	useEffect(() => {
		if (!showSkillsPicker) return;

		setIsLoading(true);
		setSearchQuery('');
		setAppendText('');
		setFocus('search');
		setSkillsSelectedIndex(0);
		setOriginalTextBeforeOpen(buffer.getFullText());

		// Let UI render loading state first.
		setTimeout(() => {
			import('../../mcp/skills.js')
				.then(async m => m.listAvailableSkills(process.cwd()))
				.then(list => {
					setAllSkills(list);
					setIsLoading(false);
				})
				.catch(error => {
					console.error('Failed to load skills:', error);
					setAllSkills([]);
					setIsLoading(false);
				});
		}, 0);
	}, [showSkillsPicker, buffer]);

	const closeSkillsPicker = useCallback(() => {
		setShowSkillsPicker(false);
		setSkillsSelectedIndex(0);
		setSearchQuery('');
		setAppendText('');
		setFocus('search');
		triggerUpdate();
	}, [triggerUpdate]);

	const toggleFocus = useCallback(() => {
		setFocus(prev => (prev === 'search' ? 'append' : 'search'));
		triggerUpdate();
	}, [triggerUpdate]);

	const appendChar = useCallback(
		(ch: string) => {
			if (!ch) return;
			if (focus === 'search') {
				setSearchQuery(prev => prev + ch);
				setSkillsSelectedIndex(0);
			} else {
				setAppendText(prev => prev + ch);
			}
			triggerUpdate();
		},
		[focus, triggerUpdate],
	);

	const backspace = useCallback(() => {
		if (focus === 'search') {
			setSearchQuery(prev => (prev.length > 0 ? prev.slice(0, -1) : prev));
			setSkillsSelectedIndex(0);
		} else {
			setAppendText(prev => (prev.length > 0 ? prev.slice(0, -1) : prev));
		}
		triggerUpdate();
	}, [focus, triggerUpdate]);

	const confirmSelection = useCallback(async () => {
		if (isLoading) return;
		if (filteredSkills.length === 0) {
			closeSkillsPicker();
			return;
		}

		const selected = filteredSkills[skillsSelectedIndex];
		if (!selected) {
			closeSkillsPicker();
			return;
		}

		const injected = await buildInjectedSkillText(selected, appendText);
		// 结束标记：用于让 display-only mask 只折叠注入块本身。
		// 注意：必须以换行结尾，否则用户在占位符后继续输入时会与 "# Skill End" 黏连，
		// 导致 mask 无法识别 end marker，从而把用户输入也一并折叠掉。
		const injectedWithEndMarker = `${injected}\n# Skill End\n`;
		const original = originalTextBeforeOpen.trim();

		buffer.setText('');
		if (original) {
			buffer.insert(original);
			buffer.insert('\n\n');
		}

		// 视觉层只显示占位符，但发送时通过 buffer.getFullText() 仍会还原完整注入块。
		// 注意：末尾空格用于让用户继续输入时视觉上分隔开。
		buffer.insertTextPlaceholder(
			injectedWithEndMarker,
			`[Skill:${selected.id}] `,
		);

		setShowSkillsPicker(false);
		setSkillsSelectedIndex(0);
		setSearchQuery('');
		setAppendText('');
		setFocus('search');
		triggerUpdate();
	}, [
		appendText,
		buffer,
		closeSkillsPicker,
		filteredSkills,
		isLoading,
		originalTextBeforeOpen,
		skillsSelectedIndex,
		triggerUpdate,
	]);

	return {
		showSkillsPicker,
		setShowSkillsPicker,
		skillsSelectedIndex,
		setSkillsSelectedIndex,
		skills: filteredSkills,
		isLoading,
		searchQuery,
		appendText,
		focus,
		toggleFocus,
		appendChar,
		backspace,
		confirmSelection,
		closeSkillsPicker,
	};
}
