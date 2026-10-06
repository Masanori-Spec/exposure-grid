# Third-party notices

ExposureGrid does not redistribute Krita source, binary builds, example artwork, or a Krita plugin. Test automation downloads an official release into temporary storage and invokes its command-line interface.

- Krita: https://krita.org/ — GNU GPL v3 for the application as a whole, with per-component notices in its distribution. License details: https://krita.org/en/about/license/
- The CI runner supplies Node.js, Python, Xvfb, and operating-system libraries under their respective upstream licenses. None is included in the application source artifact.
- GitHub Actions checkout, setup-node, setup-python, and upload-artifact run only in test automation under their own licenses.

All artwork under `fixtures/source.frames/` was created specifically for this project. Source and fixtures are not derived from vendor examples. No project-wide open-source license is assigned to original work.

- Playwright 1.56.0 is a development/test-only dependency under Apache License 2.0: https://github.com/microsoft/playwright/blob/v1.56.0/LICENSE . It is not included in the offline HTML. The lockfile pins dependency integrity.
- The ZIP module is original implementation using the public PKWARE format description as a specification: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT . No vendor ZIP library is bundled.
