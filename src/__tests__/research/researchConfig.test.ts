import { parseResearchConfig, validateResearchConfig, RESEARCH_CONFIG_SETTING_KEY } from '../../services/research/researchConfig';

describe('researchConfig', () => {
    it('exposes the setting key', () => {
        expect(RESEARCH_CONFIG_SETTING_KEY).toBe('research_config');
    });

    it('defaults when missing or corrupt', () => {
        const def = { excludedProfileIds: [], perProfileDailyCap: 500 };
        expect(parseResearchConfig(null)).toEqual(def);
        expect(parseResearchConfig('')).toEqual(def);
        expect(parseResearchConfig('{not json')).toEqual(def);
        expect(parseResearchConfig('{"excludedProfileIds":"x","perProfileDailyCap":500}')).toEqual(def);
    });

    it('parses a valid stored config', () => {
        expect(parseResearchConfig('{"excludedProfileIds":["a","b"],"perProfileDailyCap":1000}'))
            .toEqual({ excludedProfileIds: ['a', 'b'], perProfileDailyCap: 1000 });
    });

    it('validates the cap range 50..5000 as integers', () => {
        expect(validateResearchConfig({ excludedProfileIds: [], perProfileDailyCap: 50 }).perProfileDailyCap).toBe(50);
        expect(validateResearchConfig({ excludedProfileIds: [], perProfileDailyCap: 5000 }).perProfileDailyCap).toBe(5000);
        for (const bad of [49, 5001, 100.5, '500', null]) {
            expect(() => validateResearchConfig({ excludedProfileIds: [], perProfileDailyCap: bad })).toThrow();
        }
        expect(() => validateResearchConfig(null)).toThrow();
        expect(() => validateResearchConfig({ excludedProfileIds: [1], perProfileDailyCap: 500 })).toThrow();
    });

    it('out-of-range stored value falls back to defaults', () => {
        expect(parseResearchConfig('{"excludedProfileIds":["a"],"perProfileDailyCap":10}'))
            .toEqual({ excludedProfileIds: [], perProfileDailyCap: 500 });
    });
});
