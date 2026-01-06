import React, {
	createContext,
	useContext,
	useState,
	useEffect,
	ReactNode,
} from 'react';

interface TerminalSize {
	columns: number;
	rows: number;
}

interface TerminalSizeContextType extends TerminalSize {}

const TerminalSizeContext = createContext<TerminalSizeContextType | undefined>(
	undefined,
);

interface TerminalSizeProviderProps {
	children: ReactNode;
}

/**
 * Provider that listens to terminal resize events ONCE at the app level.
 * This prevents the MaxListenersExceededWarning by avoiding multiple
 * components each adding their own resize listeners.
 */
export function TerminalSizeProvider({children}: TerminalSizeProviderProps) {
	const [size, setSize] = useState<TerminalSize>({
		columns: process.stdout.columns || 80,
		rows: process.stdout.rows || 20,
	});

	useEffect(() => {
		function updateSize() {
			setSize({
				columns: process.stdout.columns || 80,
				rows: process.stdout.rows || 20,
			});
		}

		process.stdout.on('resize', updateSize);
		return () => {
			process.stdout.off('resize', updateSize);
		};
	}, []);

	return (
		<TerminalSizeContext.Provider value={size}>
			{children}
		</TerminalSizeContext.Provider>
	);
}

/**
 * Hook to access terminal size from context.
 * Must be used within a TerminalSizeProvider.
 */
export function useTerminalSizeContext(): TerminalSize {
	const context = useContext(TerminalSizeContext);
	if (!context) {
		// Fallback for components used outside provider (e.g., during testing)
		return {
			columns: process.stdout.columns || 80,
			rows: process.stdout.rows || 20,
		};
	}
	return context;
}
