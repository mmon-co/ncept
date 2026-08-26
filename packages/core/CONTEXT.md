# Core context

The core context owns the portable learning model. Local application behavior may coordinate it, but the model remains usable without the server or web packages.

## Language

**Course**:
A Patch whose Patch metadata includes the course label. The application queries and presents that label specially without giving Course a distinct content representation.
_Avoid_: Domain, learner scope, graph-owning model kind

**Curriculum**:
A Patch whose Patch metadata includes the curriculum label. The application queries and presents that label specially without giving Curriculum a distinct content representation.
_Avoid_: Course, specification, synthetic course

**Patch**:
The sole identified and versioned portable content unit. A Patch names exact base Patch revisions and a delta of nodes, edges, Pedagogical metadata, and Patch metadata; a root Patch has no bases and expresses its complete graph as the delta from the empty graph.
_Avoid_: Learner progress, mutable base, separate Course model

**Patch identity**:
An opaque, registry-neutral package identity. The same Patch release may be obtained from the Hub, GitHub, or another registry without changing its identity.
_Avoid_: Hub URL, Git remote, local directory

**Reification**:
Creating a new root Patch with a new opaque identity, no bases, and the same resolved graph content as the source Patch. Citations may retain hints about the former bases and likely duplication, but those hints do not reconcile content for a user.
_Avoid_: Mutating the source Patch, automatic base update

**Patch revision**:
An exact immutable Git commit of a Patch repository, including its tracked base-reference metadata, delta, Patch metadata, Materials, and other Pedagogical metadata. Local, remote, public, and private Patches use the same commit model; Materials do not version independently from their owning Patch.
_Avoid_: Material version, Course revision

**Base manifest**:
The package-manifest-like tracked metadata declaring a Patch's base Patch dependencies. Registries resolve those identities to releases independently of Git commit ancestry.
_Avoid_: Git parent, installed local path

**Patch metadata**:
Composable, queryable metadata attached to a Patch itself under the `patch:` namespace. Labels such as `course`, `curriculum`, and `author`, along with titles and Citations, are Patch metadata rather than hierarchy or distinct core models.
_Avoid_: Content-kind hierarchy, edit authority

**Citation**:
Inert, typed Patch metadata relating a Patch to an exact Patch revision, entity, external source, or user feedback. A `reified_from` Citation carries both its exact source revision and complete entity mapping; Citations never change graph topology or perform user-scoped reconciliation by themselves.
_Avoid_: Base Patch, graph edge, Observation provenance, authoritative reconciliation

**Structure graph**:
The portable topology resolved from a Patch revision's bases and delta. It contains no learner progress.
_Avoid_: Learner graph, progress graph

**Node**:
An identified portable vertex in a Structure graph, stable within its owning Patch repository across releases when the author intentionally retains its UUID. An exact Node reference first resolves a Patch release and then looks up that UUID; minting another UUID is deletion of the old identity and addition of a new one.
_Avoid_: Lesson, mastery state

**Patch resolution**:
The deterministic dependency order computed from the Base manifest, unrelated to Git commit parents. Resolution applies dependencies before dependents, applies otherwise parallel enabled Patches in the user's declared order, and applies the Personal scope last. Multiple enabled Patches that contribute to one Node are applied in that order by default rather than normalized to one source.
_Avoid_: Git ancestry order, global deduplication, canonical entity revision

**Effective node provenance**:
The exact enabled Patch release applied last to a Node's Pedagogical metadata in the resolved graph used by a Lesson. The Lesson records that release as its Observation context without normalizing equivalent references across releases.
_Avoid_: Enclosing Personal scope, canonical entity revision

**Node replacement**:
Removing an old Node identity and its incident Edges, then adding a new Node identity and new Edges. Because a Node is only an identifier, content changes are Metadata-set changes rather than in-place Node replacement.
_Avoid_: Mutating Node identity, replacing an exact Node revision

**Metadata set**:
An identified collection of properties attached to an identified Patch, node, and/or edge. Keeping metadata separate from topology allows application contexts to compose or omit properties without fabricating graph entities.

**Pedagogical metadata**:
Non-user-associated content attached to Patch nodes and edges and released with that content. Materials may be Pedagogical metadata; mastery, learner Artifacts, and other progress-like data are not.
_Avoid_: Learner state, user tag

**Notebook**:
User-authored Pedagogical content for bridge nodes, one-off Lessons, and similar local additions. It is the owned delta of the Personal scope rather than a distinct content representation.
_Avoid_: Learner state, Artifact library
