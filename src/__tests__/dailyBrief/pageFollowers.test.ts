import { readFileSync } from 'fs';
import { join } from 'path';
import { parseFollowerCount, readPageFollowers } from '../../services/dailyBrief/pageFollowers';

const fixture = readFileSync(join(__dirname, 'fixtures', 'page-followers.html'), 'utf8');
const url = 'https://www.facebook.com/example-driving-school/';
const roots = (html: string) => [...html.matchAll(/<script type="application\/json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
const link = (href: string, text: string) => `<a href="${href}"><strong>${text.split(' ')[0]}</strong> ${text.split(' ').slice(1).join(' ')}</a>`;
const read = (html: string, r: unknown[] = []) => readPageFollowers(html, r, url, '200000000000201');

describe('parseFollowerCount', () => {
    it('parsesVietnameseAndEnglishForms', () => {
        expect(parseFollowerCount('1,3K')).toEqual({ value: 1300, approximate: true, step: 100 });
        expect(parseFollowerCount('1.3K')).toEqual({ value: 1300, approximate: true, step: 100 });
        expect(parseFollowerCount('12.345')).toEqual({ value: 12345, approximate: false, step: 1 });
        expect(parseFollowerCount('12,345')).toEqual({ value: 12345, approximate: false, step: 1 });
        expect(parseFollowerCount('1,2 Tr')).toEqual({ value: 1200000, approximate: true, step: 100000 });
        expect(parseFollowerCount('1,2 triệu')).toEqual({ value: 1200000, approximate: true, step: 100000 });
        expect(parseFollowerCount('1.2M')).toEqual({ value: 1200000, approximate: true, step: 100000 });
        expect(parseFollowerCount('2k')).toEqual({ value: 2000, approximate: true, step: 1000 });
        expect(parseFollowerCount('987')).toEqual({ value: 987, approximate: false, step: 1 });
    });
    it('rejectsAmbiguousForms', () => {
        for (const text of ['1.30', '1,2345', 'abc', '', '1,3 X', '12.34.567', '1,234K']) expect(parseFollowerCount(text)).toBeNull();
    });
});

describe('readPageFollowers', () => {
    it('readsFromFollowersLinkOfThisPage', () => {
        expect(read(link('https://www.facebook.com/example-driving-school/followers/', '1,3K người theo dõi')))
            .toEqual({ followers: 1300, text: '1,3K', approximate: true });
        expect(read('', [{ text: { text: '12.345 followers' }, uri: 'https://www.facebook.com/example-driving-school/followers/' }]))
            .toEqual({ followers: 12345, text: '12.345', approximate: false });
        expect(read(link('https://www.facebook.com/profile.php?id=200000000000201&amp;sk=followers', '2K followers'))).toMatchObject({ followers: 2000 });
        expect(read(link('https://www.facebook.com/200000000000201/followers', '2K followers'))).toMatchObject({ followers: 2000 });
    });
    it('ignoresDataHrefAttribute', () => {
        expect(read('<a data-href="https://www.facebook.com/example-driving-school/followers/"><strong>1,3K</strong> người theo dõi</a>')).toBeNull();
    });
    it('ignoresParentheticalCountOutsideLink', () => {
        expect(read('<p>Người A (23K người theo dõi) đã gắn thẻ</p>')).toBeNull();
    });
    it('ignoresFollowersLinkOfAnotherPage', () => {
        expect(read(link('https://www.facebook.com/other-page/followers/', '9,9K người theo dõi'))).toBeNull();
        expect(read('', [{ text: { text: '7K người theo dõi' }, uri: 'https://www.facebook.com/other-page/followers/' }])).toBeNull();
        expect(read(link('https://evil.example/example-driving-school/followers/', '5K người theo dõi'))).toBeNull();
    });
    it('conflictingFormsGiveNull', () => {
        expect(read(link('https://www.facebook.com/example-driving-school/followers/', '1,3K người theo dõi'),
            [{ text: 'x', uri: 'https://www.facebook.com/example-driving-school/followers/' }, { text: { text: '1,4K người theo dõi' }, uri: 'https://www.facebook.com/example-driving-school/followers/' }])).toBeNull();
    });
    it('readsFixtureAndSkipsTraps', () => {
        expect(read(fixture, roots(fixture))).toEqual({ followers: 1300, text: '1,3K', approximate: true });
    });
});
