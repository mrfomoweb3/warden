import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { VaultEvent } from "@warden/shared";
import type { PaymentContext } from "./policy/context.js";
import type { Assessed, Warden } from "./warden.js";

const CycleState = Annotation.Root({
  events: Annotation<VaultEvent[]>,
  contexts: Annotation<PaymentContext[]>,
  assessed: Annotation<Assessed[]>,
});

/**
 * One Warden cycle: OBSERVE → RECALL → ASSESS → DECIDE → ACT → LEARN.
 * Idle cycles (no new events) skip straight from OBSERVE to LEARN so baselines,
 * hourly roll-ups and Walrus flushes still happen.
 */
export function buildWardenGraph(w: Warden) {
  return new StateGraph(CycleState)
    .addNode("observe", async () => ({ events: await w.observe() }))
    .addNode("recall", async (s) => {
      await w.recall(s.events);
      return {};
    })
    .addNode("assess", async (s) => ({ contexts: await w.assess(s.events) }))
    .addNode("decide", (s) => ({ assessed: w.decide(s.contexts) }))
    .addNode("act", async (s) => {
      await w.act(s.assessed);
      return {};
    })
    .addNode("learn", async (s) => {
      await w.learn(s.assessed ?? []);
      return {};
    })
    .addEdge(START, "observe")
    .addConditionalEdges("observe", (s) => (s.events.length ? "recall" : "learn"), ["recall", "learn"])
    .addEdge("recall", "assess")
    .addEdge("assess", "decide")
    .addEdge("decide", "act")
    .addEdge("act", "learn")
    .addEdge("learn", END)
    .compile();
}

export type WardenGraph = ReturnType<typeof buildWardenGraph>;
