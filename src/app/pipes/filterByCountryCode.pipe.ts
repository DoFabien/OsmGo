import { Pipe } from '@angular/core'
import type { PresetOption } from '@osmgo/type'

@Pipe({
    name: 'filterByCountryCode',
})
export class FilterByCountryCode {
    transform(
        items: PresetOption[] | null | undefined,
        countryCode: string
    ): PresetOption[] {
        if (!items) {
            return []
        }

        return items.filter(
            (item) =>
                (!item.countryCodes ||
                    item.countryCodes
                        .map((code) => code.toUpperCase())
                        .includes(countryCode)) &&
                !item.excludeCountryCodes
                    ?.map((code) => code.toUpperCase())
                    .includes(countryCode)
        )
    }
}
