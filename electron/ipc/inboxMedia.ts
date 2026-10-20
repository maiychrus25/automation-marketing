import { app } from 'electron';
import * as path from 'path';
import { InboxMediaStore } from '../../src/services/control/InboxMediaStore';

let instance: InboxMediaStore | null = null;

/** Một hộp thư tệp duy nhất cho Control API (/v1/media) và Video Studio (adopt): hạn mức dung lượng tính chung trong một instance. */
export function getInboxMediaStore(): InboxMediaStore {
    instance ??= new InboxMediaStore(path.join(app.getPath('userData'), 'control-api', 'inbox'));
    return instance;
}
