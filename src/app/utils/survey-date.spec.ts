import { surveyDateKeysToSet } from './survey-date'

describe('surveyDateKeysToSet', () => {
    it('uses the configured key on an object without a date', () => {
        expect(surveyDateKeysToSet(['amenity'], 'check_date')).toEqual([
            'check_date',
        ])
    })

    it('refreshes the date key the object already has instead of adding one', () => {
        expect(
            surveyDateKeysToSet(['natural', 'survey:date'], 'check_date')
        ).toEqual(['survey:date'])
    })

    it('refreshes both keys when the object has both', () => {
        expect(
            surveyDateKeysToSet(['check_date', 'survey:date'], 'check_date')
        ).toEqual(['survey:date', 'check_date'])
    })
})
