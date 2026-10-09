// bm53-spec §Design D3 — the fixed MyInvois state-code table (01–16) the
// company profile's `state_code` maps to a printed label. Data, not logic:
// `invoiceProfileSchema` validates the code shape (`^(0[1-9]|1[0-6])$`), and
// the profile read looks the label up here. Code 17 ("not applicable") is
// outside the profile's allowed range and so is absent.
export const MYINVOIS_STATE_LABELS: Readonly<Record<string, string>> = {
  "01": "Johor",
  "02": "Kedah",
  "03": "Kelantan",
  "04": "Melaka",
  "05": "Negeri Sembilan",
  "06": "Pahang",
  "07": "Pulau Pinang",
  "08": "Perak",
  "09": "Perlis",
  "10": "Selangor",
  "11": "Terengganu",
  "12": "Sabah",
  "13": "Sarawak",
  "14": "Wilayah Persekutuan Kuala Lumpur",
  "15": "Wilayah Persekutuan Labuan",
  "16": "Wilayah Persekutuan Putrajaya",
};

// The printed country label for the profile's `country_code`. Only `MY` is
// expected in v1 (the schema default); any other valid ISO alpha-2 code prints
// as the code itself rather than failing the render.
export const COUNTRY_LABELS: Readonly<Record<string, string>> = {
  MY: "Malaysia",
};
