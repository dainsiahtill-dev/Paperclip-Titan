import type { AcpRuntimeEvent, AcpRuntimeTurn } from 'acpx/runtime';
import type { AdapterLiveSteeringControl } from '../types.js';

export interface SteerableAcpTurn extends AcpRuntimeTurn {
  steeringState?: () => Promise<{ supported: boolean; active: boolean }>;
  steer?: (input: { text: string; correlationId: string }) => Promise<{ outcome: 'injected' | 'promptRequired'; reason?: string }>;
}

/** Tool boundaries keep automatic handoffs from interrupting external effects. */
export function createLiveAcpSteering(turn: SteerableAcpTurn): {
  control: AdapterLiveSteeringControl;
  observe: (event: AcpRuntimeEvent) => void;
} {
  const tools = new Set<string>();
  const control: AdapterLiveSteeringControl = {
    state: async () => {
      const state = await turn.steeringState?.() ?? { supported: false, active: false };
      return { ...state, busy: tools.size > 0 };
    },
    send: async (input) => {
      if (tools.size > 0) return { outcome: 'deferred', reason: 'tool_in_progress' };
      if (!turn.steer) return { outcome: 'deferred', reason: 'unsupported' };
      const state = await control.state();
      if (!state.supported || !state.active) return { outcome: 'deferred', reason: 'no_running_turn' };
      const result = await turn.steer(input);
      return result.outcome === 'injected' ? { outcome: 'injected' } : { outcome: 'deferred', reason: result.reason ?? 'no_running_turn' };
    },
  };
  return {
    control,
    observe: (event) => {
      if (event.type !== 'tool_call' || !event.toolCallId) return;
      if (event.status === 'completed' || event.status === 'failed' || event.status === 'cancelled') tools.delete(event.toolCallId);
      else tools.add(event.toolCallId);
    },
  };
}
