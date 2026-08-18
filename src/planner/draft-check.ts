import type { DraftedKb } from '../schemas/draft.js';
import type { AppKnowledge, EntityDoc, RoleDoc, StateSetup } from '../schemas/kb-app.js';
import { matchEntity, matchRole, matchState } from './kb-gaps.js';

/**
 * Does this draft ground itself?
 *
 * B2.5 writes feature specs and entity files; B2 reads them back and reports
 * what cannot be grounded. Nothing made the two agree, and a live run showed
 * what that costs: `flint draft` produced a complete, correct-looking knowledge
 * base, and `flint kb` scored it **0 grounded, 3 gaps**. Neither side was wrong
 * on its own. The draft wrote a precondition the way a tester says it —
 *
 *   "a BAP user with Vendor Admin role who is not assigned the HPB Activity
 *    Vendor User Manager role"
 *
 * — and a state name the way a filename wants it, `h365-vendor-admin-without-
 * manager`. The gap check matches states by looking for the state's name inside
 * the sentence, and that name is not in there. Two registers, one join, no
 * overlap.
 *
 * The prompt now asks for names that read inside the need. This module is what
 * makes that promise checkable: it runs the *same* matchers `flint kb` uses,
 * against the draft's own output, before anybody has left the terminal. A draft
 * that will score zero says so at the moment it is written rather than at the
 * moment somebody trusts it.
 *
 * Deterministic, no model call — it is string matching over what came back.
 */

export interface NeedCheck {
  featureId: string;
  /** The `dataNeeds` sentence, verbatim. */
  need: string;
  status: 'grounded' | 'no-entity' | 'no-state';
  /** The entity the need matched, when it got that far. */
  entity?: string;
  /**
   * What was on offer at the point it failed — state names for `no-state`,
   * entity and role names for `no-entity`. Empty when grounded.
   */
  known: string[];
}

/**
 * Check every drafted `dataNeeds` entry against the drafted knowledge base.
 *
 * `existing` is folded in because a draft extends a knowledge base rather than
 * replacing it: a need may well be grounded by an entity somebody documented
 * last month, and reporting it as stranded would send a reviewer to write a
 * file that already exists.
 *
 * A role match counts as grounded here even when no credential getter resolved.
 * Whether the getter exists is a different question, already asked and answered
 * in `roles.md` under "Needs a human" — repeating it in this list would report
 * one problem twice and imply the need itself was mis-worded.
 */
export function checkDraftNeeds(draft: DraftedKb, existing?: AppKnowledge): NeedCheck[] {
  const { entities, roles } = mergedView(draft, existing);
  const checks: NeedCheck[] = [];

  for (const feature of draft.features) {
    for (const need of feature.dataNeeds) {
      if (matchRole(need, roles) !== undefined) {
        checks.push({ featureId: feature.id, need, status: 'grounded', known: [] });
        continue;
      }

      const entity = matchEntity(need, entities);
      if (entity === undefined) {
        checks.push({
          featureId: feature.id,
          need,
          status: 'no-entity',
          known: [...entities.map((e) => e.entity), ...roles.map((r) => `role:${r.id}`)],
        });
        continue;
      }

      const state = matchState(need, entity);
      checks.push(
        state === undefined
          ? {
              featureId: feature.id,
              need,
              status: 'no-state',
              entity: entity.entity,
              known: Object.keys(entity.states),
            }
          : {
              featureId: feature.id,
              need,
              status: 'grounded',
              entity: entity.entity,
              known: [],
            },
      );
    }
  }

  return checks;
}

/**
 * The draft as the gap checker would see it, with the existing KB behind it.
 *
 * Only names matter — this view answers "would this need find a state", not
 * "how is that state reached", so the setup bodies are left empty rather than
 * half-invented from resolutions that have not been rendered yet.
 */
function mergedView(
  draft: DraftedKb,
  existing: AppKnowledge | undefined,
): { entities: EntityDoc[]; roles: RoleDoc[] } {
  const drafted: EntityDoc[] = draft.entities.map((entity) => ({
    entity: entity.entity,
    aliases: entity.aliases,
    states: Object.fromEntries(
      entity.states.map((state) => [state.name, {} as StateSetup]),
    ),
  }));
  const draftedEntities = new Set(drafted.map((e) => e.entity));

  const draftedRoles: RoleDoc[] = draft.roles.map((role) => ({
    id: role.id,
    aliases: role.aliases,
    ...(role.description !== undefined ? { description: role.description } : {}),
  }));
  const draftedRoleIds = new Set(draftedRoles.map((r) => r.id));

  return {
    entities: [
      ...drafted,
      ...(existing?.entities ?? []).filter((e) => !draftedEntities.has(e.entity)),
    ],
    roles: [
      ...draftedRoles,
      ...(existing?.roles ?? []).filter((r) => !draftedRoleIds.has(r.id)),
    ],
  };
}
