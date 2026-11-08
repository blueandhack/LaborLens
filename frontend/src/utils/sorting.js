export const defaultCaseSort = program => program === 'h1b' ? 'certification_desc' : 'event_desc';
export function caseSortOptions(program) {
  const event = program === 'pwd' ? 'Determination date' : program === 'perm' ? 'Decision date' : 'Last action date';
  const fields = [...(program === 'h1b' ? [['certification', 'Certification date']] : []), ['event', event], ['received', 'Received date']];
  return fields.flatMap(([key, label]) => [
    { value: key + '_desc', label: label + ' · newest first' },
    { value: key + '_asc', label: label + ' · oldest first' },
  ]);
}
export function readCaseSort(params, program) {
  const value = params.get('sort');
  return caseSortOptions(program).some(option => option.value === value) ? value : defaultCaseSort(program);
}
export const employerSortOptions = [
  { value: 'h1b_desc', label: 'Most H-1B applications' },
  { value: 'perm_desc', label: 'Most PERM applications' },
  { value: 'pwd_desc', label: 'Most PWD applications' },
  { value: 'name_asc', label: 'Employer name · A–Z' },
  { value: 'name_desc', label: 'Employer name · Z–A' },
];
