import {
  contentDigest,
  pedagogicalTheoryDigest,
  type ContentDigest,
  type PedagogicalTheory,
  type PlatformPedagogyRelease,
} from "../../pedagogy";
import { builtSkillBundles, tutorSystemPrompt } from "../../skills";
import { displayDefault, defaultQueryTokens } from "./display";
import { indicatorsDefault } from "./indicators";
import { acceptsDefaultParameters, DEFAULT_PARAMETERS, type NodeState } from "./labels";
import { projectDefault } from "./projection";
import { convertDefault, DEFAULT_RECORD_SCHEMAS, type DefaultRecordPayload } from "./records";
import { defaultInstrumentTools, defaultRecordingTools, type DefaultToolContext } from "./tools";

type DefaultTheory = PedagogicalTheory<DefaultRecordPayload, NodeState, DefaultToolContext>;

/** Assembly requires the real revision-update implementation and its trusted build artifact digest.
 * No fallback update is supplied: a package without update is not a complete theory.
 */
export function createDefaultPedagogicalTheory(
  update: DefaultTheory["update"],
  implementationDigest: ContentDigest,
) {
  return {
    implementationDigest,
    schemas: DEFAULT_RECORD_SCHEMAS,
    parameters: DEFAULT_PARAMETERS,
    acceptsParameters: acceptsDefaultParameters,
    project: projectDefault,
    update,
    display: displayDefault,
    queryTokens: defaultQueryTokens,
    tools: [defaultInstrumentTools, defaultRecordingTools],
    skills: { bundles: builtSkillBundles() },
    basePrompt: tutorSystemPrompt(),
    indicators: indicatorsDefault,
    convert: convertDefault,
  } satisfies DefaultTheory;
}

export function createDefaultPedagogyRelease(
  update: DefaultTheory["update"],
  implementationDigest: ContentDigest,
): PlatformPedagogyRelease<DefaultRecordPayload, NodeState, DefaultToolContext> {
  const theory = createDefaultPedagogicalTheory(update, implementationDigest);
  return {
    form: "root",
    ref: {
      identity: "pedagogy-platform",
      version: "1.0.0",
      digest: contentDigest({
        theory: pedagogicalTheoryDigest(theory),
        skills: theory.skills,
        basePrompt: theory.basePrompt,
      }),
    },
    theory: { kind: "contained", theory },
    basePrompt: theory.basePrompt,
    skillCatalog: theory.skills,
  };
}
