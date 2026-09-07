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
import { updateDefault } from "./update";
import { convertDefault, DEFAULT_RECORD_SCHEMAS, type DefaultRecordPayload } from "./records";
import {
  defaultBackgroundTools,
  defaultInstrumentTools,
  defaultRecordingTools,
  type DefaultBackgroundContext,
} from "./tools";

type DefaultTheory = PedagogicalTheory<DefaultRecordPayload, NodeState, DefaultBackgroundContext>;

/** The concrete default binds projection, revision update and tools to one implementation. */
function createDefaultPedagogicalTheory(implementationDigest: ContentDigest) {
  return {
    implementationDigest,
    schemas: DEFAULT_RECORD_SCHEMAS,
    parameters: DEFAULT_PARAMETERS,
    acceptsParameters: acceptsDefaultParameters,
    project: projectDefault,
    update: updateDefault,
    display: displayDefault,
    queryTokens: defaultQueryTokens,
    tools: [defaultInstrumentTools, defaultRecordingTools, defaultBackgroundTools],
    skills: { bundles: builtSkillBundles() },
    basePrompt: tutorSystemPrompt(),
    indicators: indicatorsDefault,
    convert: convertDefault,
  } satisfies DefaultTheory;
}

export function createDefaultPedagogyRelease(
  implementationDigest: ContentDigest,
): PlatformPedagogyRelease<DefaultRecordPayload, NodeState, DefaultBackgroundContext> {
  const theory = createDefaultPedagogicalTheory(implementationDigest);
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
