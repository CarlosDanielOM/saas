/** A durable EventSub action failed before its goal contribution was journaled. */
export class RequiredGoalContributionError extends Error {
    constructor() {
        super('Required goal contribution could not be journaled');
        this.name = 'RequiredGoalContributionError';
    }
}
