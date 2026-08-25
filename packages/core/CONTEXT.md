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

**Curriculum draft identity**:
A user-chosen curriculum identifier interpreted only in the draft namespace. Its namespace must remain explicit in types and routes.
_Avoid_: Bare curriculum ID

**Published curriculum identity**:
An opaque course identifier for the published artifact. An exact published revision pairs that identifier with its semantic version.
_Avoid_: Domain, draft ID

**Adopted curriculum identity**:
The exact published curriculum revision installed for a learner, encoded by the existing binding identifier as `course_id@version`.
_Avoid_: Bare course ID, owned domain
