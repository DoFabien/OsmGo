import { Pipe } from '@angular/core'
import type { Tag, TagConfig } from '@osmgo/type'
import { osmTagKeyToPresetId } from '@osmgo/utils'

@Pipe({
    name: 'orderByPreset',
})
export class OrderByPresetPipe {
    transform(items: Tag[], tagConfig: TagConfig): Tag[] {
        const fields: Tag[] = []
        const moreFields: Tag[] = []
        const extraTags: Tag[] = []
        const newFields: Tag[] = []
        // The category lists preset ids (`contact/phone`), a tag has a key
        // (`contact:phone`) and sometimes a preset whose id differs from it.
        const isListed = (element: Tag, presetIds: string[] = []): boolean =>
            [element.preset?._id, osmTagKeyToPresetId(element.key)].some(
                (id) => id !== undefined && presetIds.includes(id)
            )
        items.forEach((element: Tag) => {
            if (element.isJustAdded) {
                newFields.push(element)
            } else if (isListed(element, tagConfig.presets)) {
                fields.push(element)
            } else if (isListed(element, tagConfig.moreFields)) {
                moreFields.push(element)
            } else {
                extraTags.push(element)
            }
        })
        return [...fields, ...moreFields, ...extraTags, ...newFields]
    }
}
