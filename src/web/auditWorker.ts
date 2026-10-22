// Runs the audit off the main thread so the page stays responsive on large projects.

import { analyse } from './analyse';
import type { SourceFile } from '../core/types';

const scope = self as unknown as { onmessage: ((e: MessageEvent<SourceFile[]>) => void) | null; postMessage: (message: unknown) => void };
scope.onmessage = (e) => scope.postMessage(analyse(e.data));
