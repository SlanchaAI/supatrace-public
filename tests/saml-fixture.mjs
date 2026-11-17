import {SignedXml} from 'xml-crypto';

export const samlAudience = 'https://supatrace.dev/api/auth/sso';
export const samlAcs = 'https://supatrace.dev/api/auth/sso/callback';

/** Okta signs the assertion, not the response. node-saml accepts that shape. */
export function oktaResponse({privateKey, cert, requestId, nameId, notBefore, notOnOrAfter, audienceValue = samlAudience, issuer = 'http://www.okta.com/exk-test', acs = samlAcs}) {
  const now = new Date().toISOString();
  const assertionId = '_' + Buffer.from(String(Math.random())).toString('hex');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_${assertionId}r" Version="2.0" IssueInstant="${now}" Destination="${acs}" InResponseTo="${requestId}">
  <saml:Issuer>${issuer}</saml:Issuer>
  <samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>
  <saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${assertionId}" Version="2.0" IssueInstant="${now}">
    <saml:Issuer>${issuer}</saml:Issuer>
    <saml:Subject>
      <saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${nameId}</saml:NameID>
      <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
        <saml:SubjectConfirmationData InResponseTo="${requestId}" Recipient="${acs}" NotOnOrAfter="${notOnOrAfter}"/>
      </saml:SubjectConfirmation>
    </saml:Subject>
    <saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">
      <saml:AudienceRestriction><saml:Audience>${audienceValue}</saml:Audience></saml:AudienceRestriction>
    </saml:Conditions>
    <saml:AuthnStatement AuthnInstant="${now}" SessionIndex="${assertionId}">
      <saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext>
    </saml:AuthnStatement>
  </saml:Assertion>
</samlp:Response>`;
  const sig = new SignedXml({privateKey, publicCert: cert, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#'});
  sig.addReference({xpath: "//*[local-name(.)='Assertion']", uri: `#${assertionId}`, transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'], digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256'});
  sig.computeSignature(xml, {location: {reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: 'after'}});
  return Buffer.from(sig.getSignedXml()).toString('base64');
}
