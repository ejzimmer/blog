A co-worker and I were writing tests for a hook we'd created the other day, and we kept running into this mysterious warning.


```
    Warning: An update to TestHook inside a test was not wrapped in act(...).
    
    When testing, code that causes React state updates should be wrapped into act(...):
    
    act(() => {
      /* fire events that update state */
    });
    /* assert on the output */
    
    This ensures that you're testing the behavior the user would see in the browser. Learn more at https://fb.me/react-wrap-tests-with-act
        in TestHook
        in Suspense
```


We didn't find this warning particularly enlightening, especially given that a cursory reading of the linked documentation reveals
```
You might find using act() directly a bit too verbose. To avoid some of the boilerplate, you could use a library like React Testing Library, whose helpers are wrapped with act().
```

We were using React Testing Library! Everything should be wrapped in `act()` already! And our tests were actually passing. It was a bit of a mystery, so we decided to dig a little deeper and work out what was really going on. What resulted was a wild ride through the inner workings of hooks, testing utilities, and how asynchronous events are handled in JavaScript. If you're curious too, then keep reading. If you just want to know how to make the warning go away, then skip ahead to the tl;dr.


__Hooks__
This warning is very specifically related to hooks, so to understand what's going on, we first need to understand how hooks work.


Hooks give us a way to store state in a functional component. In the case of `useState()`, that state is the actual component state. But other hooks store other kinds of state - `useRef()` stores a reference to a particular object, while `useEffect()` and `useCallback()` store functions. We can't store these things inside the component - they'd get re-created as new objects each time the component rendered and the component function ran. But we also don't want to store them in global state, where anyone could just come along and change them.


Fortunately, JavaScript has a nice way to create private state specific to a particular function. We can use closures!


```js
function counter() {
    let _count = 0;
    return {
        increment: () => ++_count,
        current: () => _count
   }
}


const myCounter = counter()
console.log(myCounter.current()) // 0
myCounter.increment()
console.log(myCounter.current()) // 1
console.log(_count) // undefined
```
Here, the `counter()` function stores its internal state in a variable called `_count`. It also returns an object with two functions on it - `increment()` and `count()`. Because `_count` is defined outside of `increment()` and `current()`, both functions share the same value, and the that value is maintained independent of calls to either function. And, because `_count` is defined inside `counter()`, nothing outside `counter()` can access it. This is exactly what we want in a hook!


(If this seems confusing, have a look at [the MDN guide to closures](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Closures), or the relevant chapter in [Kyle Simpson's excellent You Don't Know JS Yet](https://github.com/getify/You-Dont-Know-JS/blob/2nd-ed/scope-closures/README.md))


If we were to have a go at defining the `useState()` hook, it might look something like this
```js
function React() {
  let _state
  return {
    useState: (initial) => {
      _state = _state || initial // if _state hasn't been set to anything, set it to the initial value
      setState = (newState) => _state = newState


      return [_state, setState]
    }
    // ... everything else React does
  }
}
```


This version of `useState` gives us the things we wanted - an external place to store state that isn't accessible to every other bit of code running on the page. It does, however, have some downsides. Most importantly, it can only store one bit of state. If our component called `useState` multiple times, each new bit of state would overwrite the previous one.

(There's also a small bug that will result in `_state` being set back to the initial value if we ever set it to something falsey. That's not really important to this discussion though, and fixing it is left as an exercise for the reader).

We can solve the only-one-bit-state problem by replacing the `_state` variable with an *array* of state values. Once we do this, we also need to add some logic to control which bit of the array we should be accessing at any given time.


```js
function React() {
  const _state = []
  let currentIndex = 0
  return {
    useState: (initial) => {
      // access the bit of state at the current index
      _state[currentIndex] = _state[currentIndex] || initial

      // make sure that we always use the same index for this particular bit of state
      // (by creating another closure!)
      const thisIndex = currentIndex
      setState = (newState) => _state[thisIndex] = newState

      // increment currentIndex so that the next hook accesses the next element in the array
      currentIndex++
      
      // return our bit of state, and a function to update it. This setState function will always
      // point to the correct element in the array, because we created a closure using thisIndex
      return [_state[thisIndex], setState]
    }
    render: () => {
       // ... actually render the component
       
       // once the component has rendered, set current index back to 0, so we're
       // ready for the next time the component runs
       currentIndex = 0
    }
    // ... whatever else React does
  }
}
```


Now that our state is in an array, we also need `currentIndex` to keep track of where each bit of state is stored within the array. Each time `useState()` is called, it saves the current value of `currentIndex` to `thisIndex`. The `setState()` function that is returned creates a closure around `thisIndex`. This means that if our `useState()` hook is called three times within a component, we'll get three different pieces of state, each with their own setter function, pointing to the correct index in the array. Finally, after our component has rendered, `currentIndex` is set back to 0, ready for the next call to `render()`.


If you're interested in understanding this better (or you would like examples of how other hooks work), then you should definitely check out Shawn Wang's post and video at https://www.swyx.io/getting-closure-on-hooks/, which is what this code was, uh, heavily inspired by.


__Testing Hooks__
One thing that this code hopefully makes clear is that a hook will really only work if it's called from within the context of a component function (as per the [Rules of Hooks](https://reactjs.org/docs/hooks-rules.html)). Hooks need to be called in the correct order, so that `currentIndex` is incremented correctly, and `currentIndex` needs to be reset after each render. This has some implications for testing hooks, as we can't just call them like we might with other JavaScript functions.

Instead, we need to use something like `renderHook()`.

```js
it('returns the initial value', () => {
    const { result } = renderHook(() => useCounter())
    expect(result.current.count).toBe(0)
})
```


We pass `renderHook()` a callback function which calls our hook. `renderHook()` generates a test component, which calls the callback function from within it. This results in our hook being called from within a component, without us having to go to all the hassle of creating a component ourselves!

`renderHook()` returns an object which has a property called `result`. The `result` object has another property called `current`, which contains the result of calling our callback.

This might seem like a rather convoluted way of going about things, but there's a very good reason for it. `result.current` will always point to the value returned by the hook, even if that value changes after `renderHook()` has returned. This allows us to test hooks which are able to change their own state.


To understand what's going on, lets imagine that `renderHook()` just returned `result`.


```js
it('increments the counter', () => {
    const result = renderHook(() => useCounter())
    const { count, incrementCount } = result
    expect(count).toBe(0) // all good!
    incrementCount()
    expect(count).toBe(1) // oh noes, even though the hook has updated the state of the variable in its closure
                          // _this_ count variable still points to the initial value of 0, and the test fails!
})
```
Our test fails! But why? Well, the call to `renderHook()` returns a state value (`count`) of 0, and a setter function (`incrementCount()`). Calling `incrementCount()` updates the state, and causes `renderHook()`'s fake test component to re-render. Re-rendering calls the `useCounter()` hook again, which returns an updated value for `count` of 1. But there's no way to pass this value back from the component to our test, so it just disappears into the ether. Our test is stuck with its initial `count` value of 0, and everything consequently fails. 


To solve this problem, `renderHook()` can instead return an object with a `current` property. Both `renderHook()` and our test have access to this object. The `current` property of this object contains the most recent value returned by our hook. Whenever the test component re-renders, `renderHook()` can update the value of `current` with the new return value from our callback, and our test can then read the new value. This is quite similar to the functionality provided by the `useRef` hook.

THIS NEEDS A DIAGRAM

```js
it('increments the counter', () => {
    const result = renderHook(() => useCounter())
    expect(result.current.count).toBe(0) // all good, just like before
    result.current.incrementCount() // the value of `current` is updated
    expect(result.current.count).toBe(1) // now this works too!
})
```
Of course, in the real world, `renderHook()` involves one more layer of indirection. Rather than just returning a `result` object, it returns an object with a `result` property. The reason for this is much more straighforward though - `renderHook()` returns a bunch of utility functions along with the result, so they all need to be batched up in an object together.

SHOW WHAT IS ACTUALLY RETURNED


__The Act Warning__
This - finally - brings us to the warning that started this whole thing. 


```
Warning: An update to TestHook inside a test was not wrapped in act(...).
    
    When testing, code that causes React state updates should be wrapped into act(...):
    
    act(() => {
      /* fire events that update state */
    });
    /* assert on the output */
    
    This ensures that you're testing the behavior the user would see in the browser. Learn more at https://fb.me/react-wrap-tests-with-act
        in TestHook
        in Suspense
```


As I mentioned earlier, this is particularly confusing because the docs clearly state that both `render()` and `renderHook()` already wrap the code in `act()`.


So what's going on?


Well, one hint is that you're only going to see this warning if your hook is doing something asynchronous - like calling an API, or using a timer. If your hook uses `async/await`, or does something in the `then()` of a promise, or a `setTimeout()` callback, it's potentially going to cause a problem. This is due to the way that JavaScript manages these asynchronous events. 


Imagine we had a hook for fetching details about Nintendo Amiibo:
```js
function useAmiibo(name) {
   const [amiibo, setAmiibo] = useState()
   fetch(`https://www.amiiboapi.com/api/amiibo/?name=${name}`)
    .then((response) => response.json())
    .then((response) => setAmiibo(response))
    
   return amiibo
}
```
(This is a real API; you can call it if you like)


We can test it with a test like this:


```js
it('fetches Zelda', () =>  {
    const { result } = renderHook(() => useAmiibo(name))
    expect(result.current.amiibo[0].gameSeries.toBe('The Legend of Zelda')
})
```


The code will run in the following order:
1. `renderHook(() => useAmiibo(name)` in the test
2. `renderHook()` internal code, which calls useAmiibo
3. `const [amiibo, setAmiibo] = useState()` in the component
4. `fetch(...)` in the component


At this point, `fetch()` will send off the network request, and `useAmiibo` will return the (currently `undefined`) `amiibo` object. The final line of the test will run, and the test will fail, because `result.current` currently points to any `undefined` `amiibo`. 

_After_ the test has returned, the `then()` blocks of the hook will run. `renderHook()` will notice that the state changed after the test finished, and it will throw that pesky warning.


In this case, the warning isn't very helpful, because the test fails. We already know something has gone wrong. The warning is really there to guard against tests _passing_ incorrectly. Imagine if we had a test that checked that an error wasn't thrown.

```js
it('fetches nothing', () => {
    expect(renderHook(() => useAmiibo(name))).not.toThrow()
})
```

This test will pass. But it's not really testing the right thing. If an error was thrown in the `then()` part of our hook, it wouldn't be thrown until after the test had already returned (successfully). The `act()` warning is warning us about situations like this - cases when an asynchronous action would have caused something to happen _after_ the test had already finished. Hopefully you agree that while the wording of the warning is a little confusing, the warning itself is potentially very helpful. After all, reasoning about asynchronous stuff is _hard_.

If you're interested in the details of how JavaScript handles asynchronous code and promises, check out Jake Archibald's article on [https://jakearchibald.com/2015/tasks-microtasks-queues-and-schedules/](Tasks, microtasks, queues and schedules). Or you can watch a [https://www.youtube.com/watch?v=2qDNgBgKsXI](video of me, talking about the Event Loop).


__Can we fix it?__
Yes, we can, and the fix is actually quite simple. One of the utility functions returned by `renderHook()` is a function called `waitForNextUpdate()` which forces our code to pause until the next tick of the event loop - ie until any `then()`s have been executed.


```js
it('fetches Zelda', async () => {
    const { result, waitForNextUpdate } = renderHook(() => useAmiibo(name))
    await waitForNextUpdate()
    expect(result.current.amiibo[0].gameSeries.toBe('The Legend of Zelda')
}
```

__One last problem__
While we've now solved the issue of testing our hook, we are left with one last little problem - testing a component that uses our hook. 


```js
function ShowAmiibo({ name }) {
    const amiibo = useAmiibo(name)
   return amiibo && <img src={amiibo.image} alt={name} /> || null
}
```
This component gets a name passed in on `props`, fetches the matching Amiibo and displays it.


```js
it('shows Zelda', () => {
    render(<ShowAmiibo name='zelda' />)
    expect(screen.getByAltText('zelda')).toBeTruthy()
}
```


The test fails _and_ it throws that same warning again! Just like before, the test is completing before the async part of our hook has run. We don't have access to `waitForNextUpdate()` here, because we never called `renderHook()`. We can, however, use the `waitFor()` function supplied by `@testing-library/react` to do something very similar. The major difference is that we need to tell `waitFor()` what it is that it needs to wait for.


```js 
it('shows Zelda', async () => {
    render(<ShowAmiibo name='zelda')
    await waitFor(() => screen.getByAltText('zelda'))
    expect(screen.getByAltText('zelda').toBeTruthy()
}
```


You don't always have to wait for an element to appear either. For example, the situation that kicked off this whole investigation involved a hook which called an API to check if a user had access to a specific endpoint. There were three possible scenarios.
1. The user definitely has access. Do nothing.
2. The user definitely doesn't have access. Hide the form component and show a message.
3. We're not sure if the user has access - either because the API call hasn't returned yet, or it returned an error. In these cases, we want to do nothing. It was better to allow a user who did not have access to try and use the form than to block or slow down a user who did have access. (The unauthorised user would get blocked after they submitted the form anyway.)
```


Because scenarios 1 and 3 didn't involve any changes, we couldn't wait for any specific element to appear on the screen. Instead, we waited for the API call to happen.


```js
it('doesn\'t change anything when the API returns', async () => {
   render(<AccessControlledForm />)
   await waitFor(() => expect(axiosSpy).toHaveBeenCalled())
   expect(form).toBeTruthy()
}
```


Similarly, if you find yourself in a situation where you need to wait for an element to disappear, rather than appear, you can use `waitForElementToBeRemoved()`, also supplied by `@testing-library/react`. This could be helpful if you need to wait for a loading indicator to disappear.


```js
it('shows Zelda', async () => {
    render(<ShowAmiibo name='zelda' />
    await waitForElementToBeRemoved(() => screen.getByTestId('spinner'))
    expect(screen.getByAltText('zelda').toBeTruthy()
})


__tl;dr__
- Hooks are made of closures and rely on the component lifecycle to work correctly. As a result, you need to use something like `renderHook()` to test them.
- Async code executing after your test has finished will result in a warning being thrown. This is a Good Thing as it helps ensure that you're testing exactly what you intend to test.
- `await waitForNextUpdate()` will pause your test until the next event loop tick, ensuring any async callbacks have run
- `await waitFor(...)` will wait until a specific condition has been met. You can wait for anything, but the most common use cases are waiting for a DOM element to appear, or waiting for a specific function (like `Axios.get`) to have been called. You can also `await waitForElementToBeRemoved(...)`


Hopefully, all of this has given you a better understanding of how hooks work, and will help you avoid pesky warnings in your tests in the future!






































<!--stackedit_data:
eyJoaXN0b3J5IjpbLTM1NTI2NjI3OSw1NDQxNDEyNjQsMTU1Nz
k0NjczNywxNzc5OTQ4MDk5XX0=
-->