export type UID = `${string}-${string}-${string}-${string}-${string}`;

export enum IdPrefixes {}

const DUMMY_UUID: UID = 'DUMMY-DUMMY-DUMMY-DUMMY-DUMMY';

export const isUUID = (target: string) => {
    const sanitized = target.trim().replace(' ', '').replace('-', '');
    if (sanitized.length !== 32) {
        return false;
    }
    return true;
};
