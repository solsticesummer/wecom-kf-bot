// Action handlers: what the bot RECORDS once the model has decided what a message was.
//
// Replaces the `if (action === 'bug') … if (action === 'handoff') …` chain that used to sit
// inline in the message pipeline. Adding an action to a skill now means registering a
// handler here instead of editing the pipeline, which is what keeps server.ts channel code
// rather than product code.
//
// Deliberately narrow: a handler only touches the state store. What gets SENT to the
// customer (the reply, the 转人工 menu) and whether the session moves to the human queue are
// channel concerns, driven from the skill's declarative `handoff:` flag in server.ts. Two
// reasons to keep that split: the send order is load-bearing and belongs in one readable
// place, and a second channel would reuse these handlers unchanged.

import type { StateStore } from './state.js';
import type { GenerateResult } from './ai.js';

export interface ActionContext {
  store: StateStore;
  /** The customer (external_userid). */
  userId: string;
  /** What the customer said. */
  userText: string;
  /** The model's decision, already validated by generateReply. */
  result: GenerateResult;
}

export type ActionHandler = (ctx: ActionContext) => void;

export const actionHandlers: Record<string, ActionHandler> = {
  // 'answer' has no side effect to record — the reply is the whole outcome.

  bug: ({ store, userId, userText, result }) => {
    const bug = store.addBug({
      userId,
      message: userText,
      summary: result.bugSummary || userText.slice(0, 100),
    });
    console.log(`[bug #${bug.id}] ${bug.summary}`);
  },

  // Coverage-gap log: the bot couldn't answer from the KB (or the API failed). Note this
  // also captures by-design handoffs (商务合作 / 充值优惠 / 情绪激动); keeping the reply lets
  // staff tell real gaps from those.
  handoff: ({ store, userId, userText, result }) => {
    const entry = store.addUnanswered({
      userId,
      message: userText,
      reply: result.reply,
      reason: result.handoffReason,
    });
    console.log(`[unanswered #${entry.id}] (${result.handoffReason}) ${userText.slice(0, 80)}`);
  },

  // Human staff distribute the account; when their message appears in the sync stream
  // (origin 5) the bot follows up with the credits tip.
  account: ({ store, userId }) => {
    store.setPendingTip(userId);
  },
};

/**
 * Run the handler for `action`, if it has one. Silent when there is none: plenty of actions
 * are pure replies, and generateReply has already rejected any name the tenant doesn't run.
 */
export function runAction(action: string, ctx: ActionContext): void {
  actionHandlers[action]?.(ctx);
}
