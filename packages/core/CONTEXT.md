# Core context

The core context owns the portable learning model. Local application behavior may coordinate it, but the model remains usable without the server or web packages.

## Language

**Package**:
The portable model behind courses and curricula: pinned bases, modifications, an owned patch graph, and package tags. Package is a model term, not a presented interface kind.

**Course**:
A presented package kind for a pedagogical work. It may be authored, derived, or remixed, and its interface centers content the work owns.
_Avoid_: Domain, curriculum

**Curriculum**:
A presented package kind that composes pinned course members with package modifications, an owned patch graph, and tags. Lazy slots may exist only in a draft; published curricula have concrete members.
_Avoid_: Course, specification, synthetic course
