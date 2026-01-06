import {useTerminalSizeContext} from '../../ui/contexts/TerminalSizeContext.js';

/**
 * Hook to get current terminal size.
 * Uses shared context to avoid multiple resize listeners (MaxListenersExceededWarning).
 */
export function useTerminalSize(): {columns: number; rows: number} {
	return useTerminalSizeContext();
}
