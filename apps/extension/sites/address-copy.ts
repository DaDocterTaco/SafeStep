import type { AddressObservation } from '@safestep/contracts';
export function explainAddress(a: AddressObservation) {
  const text: Record<AddressObservation['relationship'], string> = {
    expected_host: 'The hostname matches the expected site.',
    same_registered_domain_other_host:
      'This is another host under the same registered domain. It is outside this workflow.',
    different_domain: 'This address goes to a different website.',
    no_expected_site: 'No expected website was selected for comparison.',
    uninspectable_destination: 'This control has no inspectable web destination.',
    invalid_or_unsupported_address: 'This address could not be parsed as a web destination.',
  };
  return text[a.relationship];
}
export const flagText: Record<AddressObservation['flags'][number], string> = {
  user_info: 'Sign-in-style text appears before the actual host.',
  label_mismatch: 'The visible URL names a different host.',
  embedded_expected_domain: 'The expected domain appears inside a different address.',
  similar_spelling: 'The spelling resembles the expected site. This is only a clue.',
  international: 'Internationalized hostname, shown in ASCII.',
  ip_address: 'This is an IP address.',
  unknown_suffix: 'No known registration boundary.',
  unexpected_scheme: 'The expected site uses HTTPS.',
  nondefault_port: 'The address has an explicit nonstandard port.',
  trailing_dot: 'A trailing dot was normalized for comparison.',
};
