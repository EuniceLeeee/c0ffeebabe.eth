export function familyTestSourceFingerprint(root?: string): string;
export function parseFamilyTestArguments(argv: string[]): { values: Map<string, string>; offline: boolean };
export function summarizeFamilyTransactionResults(family: any, legs: any[], offlinePassed: boolean): any;
export function familyTestMain(argv?: string[], hooks?: Record<string, any>): Promise<{ exitCode: number; report?: any; reportPath?: string }>;
