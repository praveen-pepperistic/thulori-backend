// The single source of truth for what is sold. Prices are in paise and are always
// computed on the server — the browser only sends edition keys.
export const EDITIONS = {
  vidhai: { name: 'Vidhai', pricePaise: 3999_00, photos: 40, revisionRounds: 1 },
  thulir: { name: 'Thulir', pricePaise: 6999_00, photos: 100, revisionRounds: 2 },
  malar:  { name: 'Malar',  pricePaise: 9999_00, photos: 150, revisionRounds: 3 },
} as const;
export type Edition = keyof typeof EDITIONS;
export const EDITION_KEYS = Object.keys(EDITIONS) as Edition[];

export const STAGES = ['Photos & stories', 'Writing', 'Design', 'Your proof', 'Printing', 'On its way', 'Delivered'] as const;
export const STAGE = { PHOTOS: 0, WRITING: 1, DESIGN: 2, PROOF: 3, PRINTING: 4, SHIPPED: 5, DELIVERED: 6 } as const;

export const MIN_PHOTOS_TO_SUBMIT = 10;
export const MIN_STORIES_TO_SUBMIT = 5;

export const INDIAN_STATES = ['Andhra Pradesh','Arunachal Pradesh','Assam','Bihar','Chandigarh','Chhattisgarh','Delhi','Goa','Gujarat','Haryana','Himachal Pradesh','Jammu & Kashmir','Jharkhand','Karnataka','Kerala','Ladakh','Madhya Pradesh','Maharashtra','Manipur','Meghalaya','Mizoram','Nagaland','Odisha','Puducherry','Punjab','Rajasthan','Sikkim','Tamil Nadu','Telangana','Tripura','Uttar Pradesh','Uttarakhand','West Bengal'];
