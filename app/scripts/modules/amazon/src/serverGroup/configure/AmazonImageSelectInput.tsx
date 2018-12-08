import * as React from 'react';
import { IPromise } from 'angular';
import { $q } from 'ngimport';
import { ReactSelectProps } from 'react-select';
import { Subject, Observable } from 'rxjs';

import { Application, HelpField, TetheredSelect, ValidationMessage } from '@spinnaker/core';

import { AwsImageReader, IAmazonImage } from 'amazon/image';

export interface IAmazonImageSelectorProps {
  onChange: (value: IAmazonImage) => void;
  value: IAmazonImage;
  application: Application;
  credentials: string;
  region: string;
}

export interface IAmazonImageSelectorState {
  errorMessage?: string;
  selectionMode: 'packageImages' | 'searchAllImages';
  searchString: string;
  searchResults: IAmazonImage[];
  isSearching: boolean;
  packageImages: IAmazonImage[];
  isLoadingPackageImages: boolean;
}

export class AmazonImageSelectInput extends React.Component<IAmazonImageSelectorProps, IAmazonImageSelectorState> {
  public state: IAmazonImageSelectorState = {
    errorMessage: null,
    selectionMode: 'packageImages',
    searchString: '',
    searchResults: null,
    isSearching: false,
    packageImages: null,
    isLoadingPackageImages: true,
  };

  private awsImageReader = new AwsImageReader();
  private props$ = new Subject<IAmazonImageSelectorProps>();
  private searchInput$ = new Subject<string>();
  private destroy$ = new Subject();

  public static makeFakeImage(imageName: string, imageId: string, region: string): IAmazonImage {
    if (!imageName && !imageId) {
      return null;
    }

    // assume that the specific image exists in the selected region
    const amis = { [region]: [imageId] };
    const attributes = { virtualizationType: '*' };

    return { imageName, amis, attributes } as IAmazonImage;
  }

  private loadImagesFromApplicationName(application: Application): IPromise<IAmazonImage[]> {
    const query = application.name.replace(/_/g, '[_\\-]') + '*';
    return this.awsImageReader.findImages({ q: query });
  }

  private buildQueryForSimilarImages(imageName: string) {
    let addDashToQuery = false;
    let packageBase = imageName.split('_')[0];
    const parts = packageBase.split('-');
    if (parts.length > 3) {
      packageBase = parts.slice(0, -3).join('-');
      addDashToQuery = true;
    }

    const tooShort = !packageBase || packageBase.length < 3;
    return tooShort ? null : packageBase + (addDashToQuery ? '-*' : '*');
  }

  private findImagesSimilarTo(exactImage: IAmazonImage): IPromise<IAmazonImage[]> {
    if (exactImage === null) {
      return $q.when([]);
    }

    const similarImagesQuery = this.buildQueryForSimilarImages(exactImage.imageName);

    if (similarImagesQuery === null) {
      return $q.when([exactImage]);
    }

    return this.awsImageReader.findImages({ q: similarImagesQuery }).then(similarImages => {
      if (!similarImages.find(image => image.imageName !== exactImage.imageName)) {
        // findImages has a limit of 1000 and may not always include the current image, which is confusing
        similarImages = similarImages.concat(exactImage);
      }

      return similarImages.sort((a, b) => a.imageName.localeCompare(b.imageName));
    });
  }

  private loadImagesFromImageId(imageId: string, region: string, credentials: string): IPromise<IAmazonImage[]> {
    return this.awsImageReader
      .getImage(imageId, region, credentials)
      .then(image => this.findImagesSimilarTo(image))
      .catch(() => [] as IAmazonImage[]);
  }

  private searchForImages(query: string): IPromise<IAmazonImage[]> {
    const hasMinLength = query && query.length >= 3;
    return hasMinLength ? this.awsImageReader.findImages({ q: query }) : $q.when([]);
  }

  private fetchPackageImages(
    value: IAmazonImage,
    region: string,
    credentials: string,
    application: Application,
  ): IPromise<IAmazonImage[]> {
    const imageId = value && value.amis && value.amis[region] && value.amis[region][0];

    return imageId
      ? this.loadImagesFromImageId(imageId, region, credentials)
      : this.loadImagesFromApplicationName(application);
  }

  private selectImage(selectedImage: IAmazonImage) {
    if (this.props.value !== selectedImage) {
      this.props.onChange(selectedImage);
    }
  }

  private findMatchingImage(images: IAmazonImage[], selectedImage: IAmazonImage) {
    return images.find(img => selectedImage && selectedImage.imageName === img.imageName);
  }

  public componentDidMount() {
    const region$ = this.props$.map(x => x.region).distinctUntilChanged();
    const { value, region, credentials, application } = this.props;

    this.setState({ isLoadingPackageImages: true });
    const packageImages$ = Observable.fromPromise(this.fetchPackageImages(value, region, credentials, application))
      .catch(err => {
        console.error(err);
        this.setState({ errorMessage: 'Unable to load package images' });
        return Observable.of([] as IAmazonImage[]);
      })
      .do(() => this.setState({ isLoadingPackageImages: false }));

    const packageImagesInRegion$ = packageImages$
      .combineLatest(region$)
      .map(([packageImages, latestRegion]) => packageImages.filter(img => !!img.amis[latestRegion]));

    const searchString$ = this.searchInput$
      .do(searchString => this.setState({ searchString }))
      .distinctUntilChanged()
      .debounceTime(250);

    const searchImages$ = searchString$
      .do(() => this.setState({ isSearching: true }))
      .switchMap(searchString => this.searchForImages(searchString))
      .catch(err => {
        console.error(err);
        this.setState({ errorMessage: 'Unable to search for images' });
        return Observable.of([] as IAmazonImage[]);
      })
      .do(() => this.setState({ isSearching: false }));

    const searchImagesInRegion$ = searchImages$.combineLatest(region$).map(([searchResults, latestRegion]) => {
      const { searchString } = this.state;
      // allow 'advanced' users to continue with just an ami id (backing image may not have been indexed yet)
      if (searchResults.length === 0 && !!/ami-[0-9a-f]{8,17}/.exec(searchString)) {
        const fakeImage = AmazonImageSelectInput.makeFakeImage(searchString, searchString, latestRegion);
        return [fakeImage].filter(x => !!x);
      }

      // Filter down to only images which have an ami in the currently selected region
      return searchResults.filter(img => !!img.amis[latestRegion]);
    });

    searchImagesInRegion$.takeUntil(this.destroy$).subscribe(searchResults => this.setState({ searchResults }));
    packageImagesInRegion$.takeUntil(this.destroy$).subscribe(packageImages => {
      this.setState({ packageImages });
      this.selectImage(this.findMatchingImage(packageImages, this.props.value));
    });

    // Clear out the selected image if the region changes and the image is not found in the new region
    region$
      .switchMap(selectedRegion => {
        const image = this.props.value;
        if (this.state.selectionMode === 'packageImages') {
          // in packageImages mode, wait for the packageImages to load then find the matching one, or undefined
          return packageImagesInRegion$.map(images => this.findMatchingImage(images, image));
        } else {
          // in searchImages mode, return undefined if the selected image is not found in the new region
          const hasAmiInRegion = !!(image && image.amis && image.amis[selectedRegion]);
          return Observable.of(hasAmiInRegion ? image : undefined);
        }
      })
      .takeUntil(this.destroy$)
      .subscribe(image => this.selectImage(image));
  }

  public componentDidUpdate() {
    this.props$.next(this.props);
  }

  public componentWillUnmount() {
    this.destroy$.next();
  }

  public render() {
    const { value, credentials, region, onChange } = this.props;
    const {
      isLoadingPackageImages,
      isSearching,
      selectionMode,
      packageImages,
      searchResults,
      searchString,
    } = this.state;
    const isPackageImagesLoaded = !!packageImages;

    const ImageOptionRenderer = (image: IAmazonImage) => {
      const amis = image.amis || {};
      const imageIdForSelectedRegion = amis[region] && amis[region][0];
      const message = imageIdForSelectedRegion
        ? `(${imageIdForSelectedRegion})`
        : ` - not found in ${credentials}/${region}`;

      return (
        <>
          <span>{image.imageName}</span>
          <span>{message}</span>
        </>
      );
    };

    const commonReactSelectProps: ReactSelectProps<any> = {
      clearable: false,
      required: true,
      valueKey: 'imageName',
      optionRenderer: ImageOptionRenderer,
      valueRenderer: ImageOptionRenderer,
      onSelectResetsInput: false,
      onBlurResetsInput: false,
      onCloseResetsInput: false,
      value,
    };

    const error = this.state.errorMessage ? <ValidationMessage message={this.state.errorMessage} type="error" /> : null;

    const noResultsText = `No results found in ${credentials}/${region}`;

    if (selectionMode === 'searchAllImages') {
      // User can search for any image using the typeahead
      // Results are streamed from the back end as the user types
      const lessThanThreeChars = !searchString || searchString.length < 3;
      const searchNoResultsText = lessThanThreeChars
        ? 'Please enter at least 3 characters'
        : isSearching
          ? 'Searching...'
          : noResultsText;

      return (
        <div className="col-md-9">
          <TetheredSelect
            {...commonReactSelectProps}
            isLoading={isSearching}
            placeholder="Search for an image..."
            filterOptions={false as any}
            noResultsText={searchNoResultsText}
            options={searchResults}
            onInputChange={searchInput => this.searchInput$.next(searchInput)}
            onChange={onChange}
          />
          {error}
        </div>
      );
    } else if (isPackageImagesLoaded) {
      // User can pick an image from the preloaded 'packageImages' using the typeahead
      return (
        <div className="col-md-9">
          <TetheredSelect
            {...commonReactSelectProps}
            isLoading={isLoadingPackageImages}
            placeholder="Pick an image"
            noResultsText={noResultsText}
            options={packageImages}
            onChange={onChange}
          />
          {error}
          <button type="button" className="link" onClick={() => this.setState({ selectionMode: 'searchAllImages' })}>
            Search All Images
          </button>{' '}
          <HelpField id="aws.serverGroup.allImages" />
        </div>
      );
    } else {
      // Show a disabled react-select while waiting for 'packageImages' to load
      return (
        <div className="col-md-9">
          <TetheredSelect
            {...commonReactSelectProps}
            isLoading={isLoadingPackageImages}
            disabled={true}
            options={[value].filter(x => !!x)}
          />
          {error}
          <button type="button" className="link" onClick={() => this.setState({ selectionMode: 'searchAllImages' })}>
            Search All Images
          </button>{' '}
          <HelpField id="aws.serverGroup.allImages" />
        </div>
      );
    }
  }
}