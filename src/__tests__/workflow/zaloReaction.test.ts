import { Reactions } from 'zca-js';
import { resolveZaloWorkflowReaction } from '../../services/workflow/zaloReaction';

describe('resolveZaloWorkflowReaction', () => {
    it.each([
        ['1', Reactions.LIKE], ['2', Reactions.HEART], ['3', Reactions.HAHA],
        ['4', Reactions.WOW], ['5', Reactions.CRY], ['6', Reactions.ANGRY],
        ['like', Reactions.LIKE], ['LIKE', Reactions.LIKE],
        [Reactions.DISLIKE, Reactions.DISLIKE],
    ])('%s -> %s', (input, expected) => {
        expect(resolveZaloWorkflowReaction(input)).toBe(expected);
    });

    it.each([[''], ['7'], [null]])('%p -> null', (input) => {
        expect(resolveZaloWorkflowReaction(input)).toBeNull();
    });
});
