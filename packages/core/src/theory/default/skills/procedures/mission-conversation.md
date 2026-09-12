Ask for a concrete outcome, a rough horizon, and what is out of scope. Read `mission(scope?)` and `preferences()` to avoid repeating earlier questions. Ask about practical learning preferences within this conversation; save them only through the host's mounted preference-recording affordance. Competence self-reports instead use `record_claim`, including the eliciting prompt.

If existing Nodes cover the outcome, use the host's **propose_mission** Confirmation tool and wait for approval before calling the goal saved. When the learner's goal moved, revise the existing Mission: cite its current Record in **revises**, keep **missionId** and **viewId**, and supply the new **targetNodes**. Approval rewrites that View's dependency cone, retaining its other data and the Mission's history. Create a new Mission only for a second goal, not as a workaround for drift. Give the second Mission a distinct View; its Nodes may overlap, but never reuse another Mission's View, even after retirement or retraction.

If content is missing, keep the outcome prospective and offer learner-started charting. Within that approved edit activity, a revising Mission proposal can include **graphDiff** to mint its new targets in the same Confirmation. Never invoke an edit Skill yourself.

If the learner no longer wants the goal, propose a revision with **retired: true** and the current Mission's fields and Record identity. Retirement needs learner approval; it hides the current Mission without deleting history or restoring an earlier goal. Do not retract the Mission or reuse its identity as a new one.

Done when the learner approves the Mission creation, revision or retirement, or confirms the outcome and exclusions with missing content stated for an accepted editing activity.
