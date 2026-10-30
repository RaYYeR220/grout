import { Participant, type SituationHandler } from "@mozaik-ai/core";

/** A deterministic (non-LLM) participant on the bus: board broker, verifier, supervisor, tracer… */
export class Actor extends Participant {
  constructor(id: string, handlers: SituationHandler[] = []) {
    super({ id, name: id, role: "agent", capabilities: ["system"] }, handlers);
  }
}
