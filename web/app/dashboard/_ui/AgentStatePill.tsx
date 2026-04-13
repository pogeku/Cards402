// Same idea for agent states — one component, zero duplication.

import { Pill } from './Pill';
import { AGENT_STATE_LABEL, AGENT_STATE_PULSING, AGENT_STATE_TONE } from '../_lib/constants';
import type { AgentStateName } from '../_lib/types';

export function AgentStatePill({ state }: { state: AgentStateName }) {
  return (
    <Pill tone={AGENT_STATE_TONE[state]} pulse={AGENT_STATE_PULSING.has(state)}>
      {AGENT_STATE_LABEL[state]}
    </Pill>
  );
}
