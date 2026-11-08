# Data sources and coverage

The extension reads bounded public page observations on supported sites. Shopping code includes the public Resell.store and Mozilla APIs. Product evidence, seller evidence and similar-product results have distinct scopes. A missing rating, price or shipping field remains unknown.

The server contains Gemini and Google Web Risk connectors. Model explanations, domain identity, reported threats and seller feedback have different evidence requirements. The existence of a connector or a configured model does not establish a live result on this checkpoint. Automatic URL checks require user consent and applicable Chrome access. Refer to [Web Risk setup](automatic-web-risk-setup.md) for the server configuration names.

The source backup was prepared for reproducibility. Earlier independent QA exercised real Gemini on 0.8.1 and verified the SS8-04 fix on 0.8.4. Current three-site coverage, automatic Web Risk behavior and the final interface require verification on the named build. Amazon exact seller-feedback coverage remains parked.
